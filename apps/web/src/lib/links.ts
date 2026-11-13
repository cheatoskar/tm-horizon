// Deep links into the TM Horizon launcher. Every "Install in TM Horizon" button on the site is built here,
// so the format changes in one place. The launcher (apps/launcher/src/state.tsx handleLinks) understands
// tmhub://install/<id> (open the mod and start the install), tmhub://mod/<id> (open the mod) and tmhub://game/<id>.
const enc = (id: string) => encodeURIComponent(id);
export const installLink = (id: string) => `tmhub://install/${enc(id)}`;
export const modLink = (id: string) => `tmhub://mod/${enc(id)}`;
export const gameLink = (id: string) => `tmhub://game/${enc(id)}`;
