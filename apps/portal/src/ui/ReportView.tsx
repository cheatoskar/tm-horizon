import type { CheckReport, CheckSeverity, StatementOfReasons } from '@tm-hub/shared';
import { Badge } from './common.tsx';
import { fmtDate, fmtSize } from '../labels.ts';

const SEV: CheckSeverity[] = ['reject', 'flag', 'warn', 'info'];
const TONE: Record<CheckSeverity, string> = { reject: 'bad', flag: 'warn', warn: 'warn', info: 'info' };
const VT_TONE: Record<string, string> = { clean: 'ok', malicious: 'bad', suspicious: 'warn', error: 'bad' };

export function CheckReportView({ report, showFiles }: { report: CheckReport; showFiles?: boolean }) {
  const vt = report.virusTotal;
  return (
    <div className="stack">
      <div className="row">
        <Badge tone={report.verdict === 'clean' ? 'ok' : report.verdict === 'flagged' ? 'warn' : 'bad'}>{report.verdict}</Badge>
        <span className="muted small">Checked {fmtDate(report.checkedAt)}</span>
        {vt && vt.status !== 'off' && (
          <span className="small">VirusTotal: <Badge tone={VT_TONE[vt.status]}>{vt.status}{vt.positives ? ` (${vt.positives})` : ''}</Badge>{vt.link && <> <a href={vt.link} target="_blank" rel="noopener noreferrer">open</a></>}</span>
        )}
      </div>
      {SEV.map((s) => {
        const list = report.findings.filter((f) => f.severity === s);
        if (!list.length) return null;
        return (
          <div key={s}>
            {list.map((f, i) => (
              <div className="finding" key={i}>
                <Badge tone={TONE[s]}>{s}</Badge>
                <span>{f.message}{f.path && <> <code>{f.path}</code></>} <span className="muted small mono">{f.code}</span></span>
              </div>
            ))}
          </div>
        );
      })}
      {report.findings.length === 0 && <div className="muted small">No findings.</div>}
      {report.pe.length > 0 && (
        <details>
          <summary className="small">Executables ({report.pe.length})</summary>
          {report.pe.map((p) => (
            <div key={p.path} className="small" style={{ margin: 'var(--tm-s-2) 0' }}>
              <code>{p.path}</code> <span className="muted">{p.machine}{p.dll ? ', DLL' : ', EXE'}</span>
              <div className="muted wrapword">Imports: {p.imports.map((i) => `${i.dll} (${i.functions.length})`).join(', ') || 'none'}</div>
              {p.exports.length > 0 && <div className="muted wrapword">Exports: {p.exports.slice(0, 20).join(', ')}</div>}
            </div>
          ))}
        </details>
      )}
      {showFiles && report.files.length > 0 && (
        <details>
          <summary className="small">Files ({report.files.length})</summary>
          <div className="tablewrap"><table><tbody>
            {report.files.map((f) => <tr key={f.path}><td className="wrapword">{f.path}</td><td className="nowrap">{fmtSize(f.size)}</td><td className="mono small wrapword">{f.sha256.slice(0, 16)}</td></tr>)}
          </tbody></table></div>
        </details>
      )}
    </div>
  );
}

export function StatementView({ s, title = 'Statement of reasons' }: { s: StatementOfReasons; title?: string }) {
  return (
    <div className="msg" style={{ borderColor: 'var(--bad-line)' }}>
      <b>{title}</b>
      <table style={{ marginTop: 'var(--tm-s-2)' }}><tbody>
        <tr><th>Decision</th><td>{s.decision}</td></tr>
        <tr><th>Facts</th><td className="wrapword">{s.facts}</td></tr>
        <tr><th>Ground</th><td>{s.ground} <span className="muted small">({s.groundType === 'law' ? 'law' : 'terms'})</span></td></tr>
        <tr><th>Automated</th><td>{s.automated ? 'Yes, by automated means' : 'No, decided by a person'}</td></tr>
        <tr><th>Appeal</th><td className="wrapword">{s.redress}</td></tr>
        <tr><th>Decided</th><td>{fmtDate(s.decidedAt)}</td></tr>
      </tbody></table>
    </div>
  );
}
