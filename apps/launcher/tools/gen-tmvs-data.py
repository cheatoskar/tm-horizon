"""Generates the TMVS data the Presets tab needs from the TM Vibrant Shaders source tree.

  python tools/gen-tmvs-data.py <path to the TMVS repo> [<path to the tmvs-presets repo>]

Writes
  src-tauri/data/tmvs-fields.json   every preset key (src/config.cpp TMVS_FIELD): kind, slider range, and whether
                                    it is a machine setting (isSystemField: not part of a preset)
  src/data/tmvs-builtin.json        the built-in presets (menu.cpp kBuiltIn: name, line, GPU load) with tags
  public/tmvs/builtin/*.jpg         their pictures (thumbnails/*.jpg, 16:9)
and, with the second path, the example presets there (examples/<id>/<id>.ini + .jpg): the built-in preset's
own assignments from config.cpp written as a preset file.
"""
import json, os, re, shutil, sys

here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
repo = sys.argv[1]
read = lambda p: open(os.path.join(repo, p), encoding='utf-8').read()
cfg = read('src/config.cpp')
menu = read('src/menu.cpp')

rx = re.compile(r'TMVS_FIELD\("(\w+)", "([^"]*)", "([^"]*)", (\w+), (\w+), ([-\d.]+)f, ([-\d.]+)f\)')
fields = [dict(key=k, label=l, kind=kind.lower(), member=m, min=float(a), max=float(b)) for k, l, c, kind, m, a, b in rx.findall(cfg)]

def machine(k):
    return (k in ('NeonTrail', 'DisableGameMSAA', 'ReadableGameDepth', 'AutoQuality', 'DisableGameFX', 'GameMaterials', 'TargetFPS', 'WeatherSound',
                  'CinematicOnlyInReplays', 'TAAJitter', 'GameNight', 'EngineMoon', 'GameSkyClouds', 'CleanHighlights', 'GameHdr', 'EngineLights',
                  'CasterShadows', 'CasterAlphaTest', 'CleanWater', 'WaterFarReflections', 'OverlapFix', 'GameGBuffer', 'GameLight', 'ShadeMenuBars',
                  'RenderScale', 'FsrSharpness') or k.startswith(('Trail', 'Video', 'Vr')))

out = [dict(key=f['key'], kind=f['kind'], min=f['min'], max=f['max'], machine=machine(f['key'])) for f in fields]
os.makedirs(os.path.join(here, 'src-tauri', 'data'), exist_ok=True)
with open(os.path.join(here, 'src-tauri', 'data', 'tmvs-fields.json'), 'w', encoding='utf-8', newline='\n') as fh:
    fh.write('[\n' + ',\n'.join(json.dumps(f) for f in out) + '\n]\n')
print(len(out), 'fields,', sum(1 for f in out if f['machine']), 'machine')

TAGS = {
    'Vibrant': ['day'], 'Realistic': ['day', 'realistic'], 'Golden Hour': ['sunset', 'day'], 'Dreamy': ['day', 'pastel'],
    'Neon': ['night', 'neon'], 'Horizon': ['night', 'space'], 'Aurora': ['night'], 'Competition': ['day', 'clarity', 'lightweight'],
    'Performance': ['day', 'lightweight'], 'Rainy': ['rain', 'weather'], 'Replay Cinema': ['cinematic', 'replay'], 'Storm': ['rain', 'weather', 'storm'],
    'Snowstorm': ['snow', 'weather'], 'Horror': ['night', 'dark'],
}
built = []
for name, blurb, cost in re.findall(r'\{"([^"]+)", "([^"]+)", (\d)\},', menu.split('const BuiltInInfo kBuiltIn[]')[1].split('};')[0]):
    pid = re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')
    built.append(dict(id=pid, name=name, description=blurb, tags=TAGS[name], load=int(cost), games=['tmnf', 'tmuf', 'tmn-eswc', 'tm2'], image=f'tmvs/builtin/{pid}.jpg'))
    shutil.copyfile(os.path.join(repo, 'thumbnails', pid + '.jpg'), os.path.join(here, 'public', 'tmvs', 'builtin', pid + '.jpg'))
json.dump(built, open(os.path.join(here, 'src', 'data', 'tmvs-builtin.json'), 'w', encoding='utf-8', newline='\n'), indent=1, ensure_ascii=False)
print(len(built), 'built-in presets')

if len(sys.argv) > 2:
    dest = sys.argv[2]
    byMember = {f['member']: f for f in fields}
    for name in ('Competition', 'Performance', 'Horror'):
        pid = re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')
        body = cfg.split('case Preset::' + name.replace(' ', '') + ':')
        # the second occurrence is the assignments (the first is presetName())
        block = body[-1].split('break;')[0]
        lines = []
        for m in re.finditer(r's\.(\w+)(?:\[(\d)\])? = ([-\d.]+)f?;', block):
            member, idx, val = m.groups()
            f = byMember[member]
            lines.append((f, idx, float(val)))
        ini = ['; Example made from the built-in "%s" preset (its values in config.cpp). Not a community preset.' % name, '[Info]',
               'Description=%s (example entry, made from the built-in preset)' % name, '', '[Preset]']
        colors = {}
        for f, idx, val in lines:
            if f['kind'] == 'color':
                colors.setdefault(f['key'], [0, 0, 0])[int(idx)] = val
            elif f['kind'] == 'bool':
                ini.append('%s=%d' % (f['key'], int(val)))
            elif f['kind'] == 'int':
                ini.append('%s=%d' % (f['key'], int(val)))
            else:
                ini.append('%s=%.4f' % (f['key'], val))
        for k, c in colors.items():
            ini.append('%s=%.3f,%.3f,%.3f' % (k, *c))
        d = os.path.join(dest, 'presets', 'example-' + pid)
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, 'example-%s.ini' % pid), 'w', encoding='utf-8', newline='\r\n').write('\r\n'.join(ini).replace('\r\n', '\n') + '\n')
        shutil.copyfile(os.path.join(repo, 'thumbnails', pid + '.jpg'), os.path.join(d, 'example-%s.jpg' % pid))
        print('example', pid, len(lines), 'assignments')
