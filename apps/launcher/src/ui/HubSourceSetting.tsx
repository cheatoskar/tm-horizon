// Settings block for the TM Horizon Hub source (off by default) and the notice for installed
// mods the hub has revoked. Strings live here (not in the i18n files); the language follows the app.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useI18n } from '../i18n';
import { backend, isNative } from '../data/backend';
import { Toggle } from './common';
import {
  HUB_URL_PLACEHOLDER, disableHubIndex, getHubSource, hubStatus, onHubIndexChange, refreshHubIndex, revokedInstalls, setHubSource, type RevokedInstall,
} from '../data/hubIndex';

const S: Record<string, Record<string, string>> = {
  en: { title: 'TM Horizon Hub', note: 'Mods from the signed hub index. Off by default.', url: 'Hub address', refresh: 'Refresh', remove: 'Remove', key: 'Key', seq: 'Index', fetched: 'Fetched', projects: 'Projects', stale: 'Expired, may be outdated', cache: 'cache', network: 'network', loading: 'Loading…', off: 'Off', nourl: 'Enter the hub address first.', revoked: 'Revoked by the hub', byhand: 'Remove these files by hand' },
  de: { title: 'TM Horizon Hub', note: 'Mods aus dem signierten Hub-Index. Standardmäßig aus.', url: 'Hub-Adresse', refresh: 'Aktualisieren', remove: 'Entfernen', key: 'Schlüssel', seq: 'Index', fetched: 'Geladen', projects: 'Projekte', stale: 'Abgelaufen, evtl. veraltet', cache: 'Cache', network: 'Netz', loading: 'Lädt…', off: 'Aus', nourl: 'Zuerst die Hub-Adresse eintragen.', revoked: 'Vom Hub gesperrt', byhand: 'Diese Dateien von Hand entfernen' },
  pl: { title: 'TM Horizon Hub', note: 'Mody z podpisanego indeksu. Domyślnie wyłączone.', url: 'Adres huba', refresh: 'Odśwież', remove: 'Usuń', key: 'Klucz', seq: 'Indeks', fetched: 'Pobrano', projects: 'Projekty', stale: 'Wygasł, może być nieaktualny', cache: 'pamięć', network: 'sieć', loading: 'Ładowanie…', off: 'Wył.', nourl: 'Najpierw wpisz adres huba.', revoked: 'Cofnięte przez hub', byhand: 'Usuń te pliki ręcznie' },
  fr: { title: 'TM Horizon Hub', note: "Mods de l'index signé du hub. Désactivé par défaut.", url: 'Adresse du hub', refresh: 'Actualiser', remove: 'Retirer', key: 'Clé', seq: 'Index', fetched: 'Chargé', projects: 'Projets', stale: 'Expiré, peut-être obsolète', cache: 'cache', network: 'réseau', loading: 'Chargement…', off: 'Désactivé', nourl: "Saisissez d'abord l'adresse du hub.", revoked: 'Révoqué par le hub', byhand: 'Retirez ces fichiers à la main' },
};

export function HubSourceSetting() {
  const { lang, locale } = useI18n();
  const s = S[lang] ?? S.en;
  const st = useSyncExternalStore(onHubIndexChange, hubStatus);
  const [cfg, setCfg] = useState(getHubSource);
  if (!isNative) return null;
  const save = (c: typeof cfg) => { setCfg(c); setHubSource(c); };
  const toggle = () => {
    const c = { ...cfg, enabled: !cfg.enabled };
    save(c);
    if (c.enabled && c.url) void refreshHubIndex(); else if (!c.enabled) disableHubIndex();
  };
  const line = st.state === 'off' ? s.off : st.state === 'loading' ? s.loading
    : [st.keyId && `${s.key} ${st.keyId}`, st.seq !== undefined && `${s.seq} ${st.seq}`, st.fetchedAt && `${s.fetched} ${new Date(st.fetchedAt).toLocaleString(locale)} (${st.origin === 'network' ? s.network : s.cache})`, st.projects !== undefined && `${s.projects} ${st.projects}`, st.stale && s.stale, st.error && (st.error === 'no-url' ? s.nourl : st.error)].filter(Boolean).join(' · ');
  return (
    <section className="panel">
      <div className="setrow">
        <div className="grow"><b>{s.title}</b><div className="dim small setnote">{s.note}</div></div>
        <Toggle on={cfg.enabled} label={s.title} onChange={toggle} />
      </div>
      {cfg.enabled && (
        <div className="setrow">
          <div className="grow">
            <b>{s.url}</b>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <input className="text-in mono grow" value={cfg.url} placeholder={HUB_URL_PLACEHOLDER} spellCheck={false} aria-label={s.url} onChange={(e) => save({ ...cfg, url: e.target.value.trim() })} />
              <button className="btn ghost sm" disabled={st.state === 'loading'} onClick={() => void refreshHubIndex()}><RefreshCw size={14} /> {s.refresh}</button>
            </div>
            <div className="dim small setnote" role="status">{line}</div>
          </div>
        </div>
      )}
      {cfg.enabled && <HubRevocationNotice />}
    </section>
  );
}

/** Installed mods whose download the hub has revoked, with a way to take them out. */
export function HubRevocationNotice() {
  const { lang } = useI18n();
  const s = S[lang] ?? S.en;
  const st = useSyncExternalStore(onHubIndexChange, hubStatus);
  const [list, setList] = useState<RevokedInstall[]>([]);
  const [gone, setGone] = useState<string[]>([]);
  useEffect(() => { let on = true; revokedInstalls().then((l) => { if (on) setList(l); }); return () => { on = false; }; }, [st.seq, st.state]);
  const shown = list.filter((r) => !gone.includes(r.record.entryId + r.record.game));
  if (!shown.length) return null;
  return (
    <div className="setrow" role="alert">
      <div className="grow">
        {shown.map((r) => (
          <div key={r.record.entryId + r.record.game} style={{ marginBottom: 8 }}>
            <b><TriangleAlert size={14} /> {r.record.entryId} {r.version}: {s.revoked}</b>
            <div className="dim small setnote">{r.reason}</div>
            {r.record.backupId
              ? <button className="btn ghost sm" onClick={async () => { const x = await backend.catalogMods?.restore(r.record.backupId!); if (x?.ok) setGone((g) => [...g, r.record.entryId + r.record.game]); }}>{s.remove}</button>
              : <div className="dim small setnote">{s.byhand}: {r.record.files.join(', ') || r.record.root}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
