// Horizon Client: which plugins are modules and which are mods.
//
// Rule (documented choice): plugin.json has no field for this (author is "cheatoskar" for all of them),
// so the split is a list of ids. A MODULE is built into the Horizon Client and ships with every client
// build; a MOD is any other plugin installed into the client (Legacy Randomizer, TMVS 2.0 modules,
// third-party plugins). A plugin id that is not in this list is a mod.

export const HORIZON_MODULES: readonly string[] = [
  'eswc-autosave', // Autosave & Login-Fix
  'input-display',
  'wr-hunter',
  'tmx-browser',
  'scripts',
  'performance',
  'node-explorer',
  'controller-hotplug',
  'race-reader',
  'tmx-upload',
];

/** True for the modules built into the Horizon Client, false for mods. */
export const isHorizonModule = (id: string): boolean => HORIZON_MODULES.includes(id);

/**
 * Shown names of modules whose plugin.json name changed between client builds (older installs and packages still
 * say "ESWC Autosave"). The launcher shows this name on the client card, in the module list and in messages.
 */
export const HORIZON_MODULE_NAMES: Readonly<Record<string, string>> = {
  'eswc-autosave': 'Autosave & Login-Fix',
};

/** The name to show for a Horizon plugin: the module's fixed name, else the plugin.json name. */
export const horizonPluginName = (id: string, name: string): string => HORIZON_MODULE_NAMES[id] ?? name;
