// Opens the guided Linux setup dialog (LinuxSetupHost in LinuxGameSetup.tsx) from anywhere: the
// "Get" button of a game, the "TMLoader is needed" card.
import { backend } from '../data/backend';

export const LINUX_SETUP_EVENT = 'tmh-linux-setup';

/** Guided setup exists for these on Linux (Wine/umu prefix with the official setup). */
export const LINUX_GUIDED = ['tmnf', 'tmuf'];

export const onLinux = () => backend.info?.().platform === 'linux';

export function openLinuxSetup(game: string) {
  window.dispatchEvent(new CustomEvent(LINUX_SETUP_EVENT, { detail: { game } }));
}
