// Reads what matters for a review from a Windows PE file (DLL/EXE): machine, DLL flag, imports
// (normal and delay-loaded) and exported names. Read-only and bounded: a broken or hostile file
// gives `malformed`, never an endless loop.
import type { PeInfo } from '@tm-hub/shared/hub';

export interface PeParse extends PeInfo {
  /** Known packer section names (UPX, ASPack, ...), which hide the real imports. */
  packed: string[];
  malformed: string | null;
}

export const isPe = (b: Uint8Array) => b.length >= 64 && b[0] === 0x4d && b[1] === 0x5a;

const MAX_IMPORT_DLLS = 512;
const MAX_FUNCS = 8192;

const PACKER_SECTIONS = /^(upx\d?|\.aspack|\.adata|\.petite|\.mpress\d|\.nsp\d|\.themida|\.vmp\d|\.enigma\d)$/i;

export function parsePe(buf: Buffer, path = ''): PeParse | null {
  if (!isPe(buf)) return null;
  const info: PeParse = { path, machine: 'other', dll: false, imports: [], exports: [], packed: [], malformed: null };
  try {
    const lfanew = buf.readUInt32LE(0x3c);
    if (lfanew + 24 > buf.length || buf.readUInt32LE(lfanew) !== 0x00004550) {
      info.malformed = 'MZ header without a PE header';
      return info;
    }
    const coff = lfanew + 4;
    const machine = buf.readUInt16LE(coff);
    info.machine = machine === 0x14c ? 'x86' : machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : 'other';
    const nSections = buf.readUInt16LE(coff + 2);
    const optSize = buf.readUInt16LE(coff + 16);
    info.dll = (buf.readUInt16LE(coff + 18) & 0x2000) !== 0;
    const opt = coff + 20;
    const magic = buf.readUInt16LE(opt);
    const pe32plus = magic === 0x20b;
    if (magic !== 0x10b && magic !== 0x20b) {
      info.malformed = 'unknown optional header';
      return info;
    }
    const nDirs = buf.readUInt32LE(opt + (pe32plus ? 108 : 92));
    const dirBase = opt + (pe32plus ? 112 : 96);
    const dir = (i: number) => (i < nDirs ? { rva: buf.readUInt32LE(dirBase + i * 8), size: buf.readUInt32LE(dirBase + i * 8 + 4) } : { rva: 0, size: 0 });
    const secBase = opt + optSize;
    const sections: { name: string; va: number; vsize: number; raw: number; rawSize: number }[] = [];
    for (let i = 0; i < Math.min(nSections, 96); i++) {
      const s = secBase + i * 40;
      if (s + 40 > buf.length) break;
      const name = buf.subarray(s, s + 8).toString('latin1').replace(/\0.*$/, '');
      sections.push({ name, vsize: buf.readUInt32LE(s + 8), va: buf.readUInt32LE(s + 12), rawSize: buf.readUInt32LE(s + 16), raw: buf.readUInt32LE(s + 20) });
      if (PACKER_SECTIONS.test(name)) info.packed.push(name);
    }
    const off = (rva: number): number => {
      for (const s of sections) {
        const span = Math.max(s.vsize, s.rawSize);
        if (rva >= s.va && rva < s.va + span) {
          const o = s.raw + (rva - s.va);
          return o < buf.length ? o : -1;
        }
      }
      return -1;
    };
    const cstr = (rva: number, max = 512): string | null => {
      const o = off(rva);
      if (o < 0) return null;
      const end = buf.indexOf(0, o);
      const stop = end < 0 ? Math.min(buf.length, o + max) : Math.min(end, o + max);
      return buf.subarray(o, stop).toString('latin1');
    };
    const thunks = (rva: number): string[] => {
      const out: string[] = [];
      let o = off(rva);
      if (o < 0) return out;
      const w = pe32plus ? 8 : 4;
      for (let n = 0; n < MAX_FUNCS && o + w <= buf.length; n++, o += w) {
        const v = pe32plus ? buf.readBigUInt64LE(o) : BigInt(buf.readUInt32LE(o));
        if (v === 0n) break;
        const ordinalFlag = pe32plus ? 1n << 63n : 1n << 31n;
        if (v & ordinalFlag) out.push(`#${Number(v & 0xffffn)}`);
        else {
          const name = cstr(Number(v & 0x7fffffffn) + 2, 256);
          if (name) out.push(name);
        }
      }
      return out;
    };

    const imp = dir(1);
    if (imp.rva) {
      let o = off(imp.rva);
      for (let n = 0; o >= 0 && n < MAX_IMPORT_DLLS && o + 20 <= buf.length; n++, o += 20) {
        const oft = buf.readUInt32LE(o);
        const nameRva = buf.readUInt32LE(o + 12);
        const ft = buf.readUInt32LE(o + 16);
        if (!oft && !nameRva && !ft) break;
        const dll = cstr(nameRva, 260);
        if (dll) info.imports.push({ dll, functions: thunks(oft || ft) });
      }
    }
    const delay = dir(13);
    if (delay.rva) {
      let o = off(delay.rva);
      for (let n = 0; o >= 0 && n < MAX_IMPORT_DLLS && o + 32 <= buf.length; n++, o += 32) {
        const nameRva = buf.readUInt32LE(o + 4);
        const intRva = buf.readUInt32LE(o + 16);
        if (!nameRva && !intRva) break;
        const dll = cstr(nameRva, 260);
        if (dll) info.imports.push({ dll: dll + ' (delay)', functions: thunks(intRva) });
      }
    }
    const exp = dir(0);
    if (exp.rva) {
      const o = off(exp.rva);
      if (o >= 0 && o + 40 <= buf.length) {
        const nNames = Math.min(buf.readUInt32LE(o + 24), MAX_FUNCS);
        const namesOff = off(buf.readUInt32LE(o + 32));
        for (let i = 0; namesOff >= 0 && i < nNames && namesOff + i * 4 + 4 <= buf.length; i++) {
          const n = cstr(buf.readUInt32LE(namesOff + i * 4), 256);
          if (n) info.exports.push(n);
        }
      }
    }
  } catch (e) {
    info.malformed = `unreadable PE: ${(e as Error).message}`;
  }
  return info;
}

/** Imported functions a game mod rarely needs; new ones in an update are worth a human look. */
const SENSITIVE: [RegExp, string][] = [
  [/^(InternetOpen|InternetConnect|InternetReadFile|HttpOpenRequest|HttpSendRequest|URLDownloadTo)/i, 'network (WinINet/URLMon)'],
  [/^WinHttp/i, 'network (WinHTTP)'],
  [/^(socket|connect|WSAStartup|WSASocket|getaddrinfo|send|recv)$/i, 'network (sockets)'],
  [/^(CreateProcess|ShellExecute|WinExec|CreateProcessAsUser|CreateProcessWithToken)/i, 'starts programs'],
  [/^(WriteProcessMemory|VirtualAllocEx|CreateRemoteThread|NtCreateThreadEx|OpenProcess|QueueUserAPC)/i, 'touches other processes'],
  [/^(SetWindowsHookEx|GetAsyncKeyState|GetKeyboardState|RegisterRawInputDevices)/i, 'keyboard hooks'],
  [/^(CryptEncrypt|CryptGenKey|BCryptEncrypt|CryptProtectData|CryptUnprotectData)/i, 'encryption / credential APIs'],
  [/^(RegSetValue|RegCreateKey|RegDeleteKey)/i, 'writes the registry'],
  [/^(AdjustTokenPrivileges|LookupPrivilegeValue)/i, 'raises privileges'],
  [/^(SetFileAttributes|MoveFileEx)$/i, 'file attribute / boot-time moves'],
];
const SENSITIVE_DLLS = /^(wininet|winhttp|urlmon|ws2_32|wsock32|crypt32|bcrypt|advapi32)\.dll/i;

/** "dll!Function -> reason" for every sensitive import. */
export function sensitiveImports(pe: PeInfo): Map<string, string> {
  const out = new Map<string, string>();
  for (const imp of pe.imports) {
    for (const f of imp.functions) {
      const hit = SENSITIVE.find(([re]) => re.test(f));
      if (hit) out.set(`${imp.dll.toLowerCase()}!${f}`, hit[1]);
    }
    if (SENSITIVE_DLLS.test(imp.dll) && !imp.functions.length) out.set(`${imp.dll.toLowerCase()}!*`, 'network/crypto library');
  }
  return out;
}
