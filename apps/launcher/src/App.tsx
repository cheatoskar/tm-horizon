import { RevokedBanner } from './ui/RevokedBanner';
import { GbxOpenHost } from './ui/GbxOpen';
import { UpdateBanner } from './ui/Updater';
import { PageBoundary } from './ui/PageBoundary';
import { useAutoUpdates } from './ui/ModUpdates';
import { InstallTargetDialog } from './ui/InstallTarget';
import { useHubState } from './state';
import { Sidebar, TitleBar } from './ui/shell';
import { ConfirmDialog, Toasts } from './ui/common';
import { LinuxSetupHost } from './ui/LinuxGameSetup';
import { Home } from './pages/Home';
import { Library } from './pages/Library';
import { GamePage } from './pages/GamePage';
import { ModDetail, Mods } from './pages/Mods';
import { Profiles } from './pages/Profiles';
import { Servers } from './pages/Social';
import { HostCloseDialog } from './pages/HostServers';
import { Skins } from './pages/Skins';
import { Settings } from './pages/Settings';
import { Overlay } from './pages/Overlay';
import { Maps } from './pages/Maps';
import { Clips } from './pages/Clips';
import { News } from './pages/News';
import { Embedded } from './pages/Embedded';
import { Communities } from './pages/Communities';
import { TasHome } from './pages/TasCorner';
import { Media } from './pages/Media';
import { Stats } from './pages/Stats';
import { MapDetails } from './pages/MapDetails';
import { SkinLibrary } from './pages/SkinLibrary';
import { ReportDialog } from './ui/ReportDialog';
import { SetupWizardHost } from './ui/SetupWizard';
import { ClientBridgePrompt } from './ui/ClientBridge';
import { ExportPackDialog, ImportPackDialog } from './ui/PackDialogs';

function Dialogs() {
  const hub = useHubState();
  const d = hub.dialog;
  if (!d) return null;
  const close = () => hub.setDialog(null);
  if (d.kind === 'report') return <ReportDialog gameId={d.gameId} onClose={close} />;
  if (d.kind === 'import') return <ImportPackDialog initial={d.pack} onClose={close} />;
  if (d.kind === 'install') return <InstallTargetDialog modId={d.modId} onClose={close} />;
  const p = hub.profiles.find((x) => x.id === d.profileId);
  return p ? <ExportPackDialog profile={p} onClose={close} /> : null;
}

export function App() {
  const { route, mode } = useHubState();
  useAutoUpdates();
  // The overlay page is a prototype with sample cards: preview builds only.
  if (!__PUBLIC_BUILD__ && route.page === 'overlay') return <><Overlay tab={route.arg} key={route.arg ?? 'mods'} /><Toasts /></>;
  let page;
  // TAS mode: Home is the TAS tools page. Play mode has no TAS page.
  const pageId = mode === 'tas' ? (route.page === 'home' ? 'tashome' : route.page) : (route.page === 'tashome' ? 'home' : route.page);
  switch (pageId) {
    case 'library': page = <Library />; break;
    case 'game': page = <GamePage id={route.arg ?? 'tmuf'} key={route.arg} />; break;
    case 'mods': page = route.arg ? <ModDetail id={route.arg} key={route.arg} /> : <Mods />; break;
    case 'profiles': page = <Profiles initial={route.arg} key={route.arg} />; break;
    case 'maps': page = <Maps initial={route.arg} />; break;
    case 'servers': page = <Servers />; break;
    case 'community': page = <Communities />; break;
    case 'skins': page = <Skins initial={route.arg} />; break;
    case 'news': page = <News />; break;
    case 'clips': page = <Clips />; break;
    case 'media': page = <Media />; break;
    case 'stats': page = <Stats initial={route.arg} />; break;
    case 'map': page = <MapDetails arg={route.arg} />; break;
    case 'skinlib': page = <SkinLibrary initial={route.arg} />; break;
    case 'tas': page = <Embedded mode="maps" initial={`${route.arg ?? 'tmuf'}@tmtas.exchange`} />; break;
    case 'tashome': page = <TasHome />; break;
    case 'settings': page = <Settings focus={route.arg} />; break;
    default: page = <Home />;
  }
  // The embedded browser pages keep one key so the webview is not torn down per game.
  const embedded = pageId === 'maps' || pageId === 'skins' || pageId === 'tas';
  return (
    <div className={'app' + (mode === 'tas' ? ' mode-tas' : '')}>
      <TitleBar />
      <div className="body">
        <Sidebar />
        <main className={'main' + (embedded ? ' embedded' : '')} key={embedded ? pageId : mode + pageId + (route.arg ?? '')}><RevokedBanner /><UpdateBanner /><PageBoundary>{page}</PageBoundary></main>
      </div>
      {!embedded && <Toasts />}
      <ConfirmDialog />
      <LinuxSetupHost />
      <Dialogs />
      <SetupWizardHost />
      <HostCloseDialog />
      <ClientBridgePrompt />
      <GbxOpenHost />
    </div>
  );
}
