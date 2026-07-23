import re, zlib, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
PDF_ROOT = ROOT / 'src' / 'content' / 'characters' / 'introductions pdf'
OUT_ROOT = ROOT / 'src' / 'content' / 'characters' / 'profiles'

QUOTES = {
    'Blues': 'Hmmm, I love this song!',
    'Fizz': 'I am ready to fly!',
    'Glup': 'Tiny slime, big city adventure!',
    'Minty': 'No ingredients, no cooking!',
    'Punk': 'Three eyes and one very long tail, ready to play!',
    'Lockby': 'Big candy, big fun!',
    'Carl': 'Hmm... a self-heating coffee mug sounds useful!',
    'Zippy': 'Ready to skate, and definitely ready to win!',
    'Rowdy': 'Hey! Who took away my glasses?!',
    'Fazer': 'Ready for the awesome adventures with me?',
    'Rushy': 'Are you interested in my square glasses?',
    'Zesty': 'Wanna see me surfing?',
    'Verde': 'You really should visit Voxel World!',
    'Mish': 'This is the paper eyes I drew for you!',
    'Wisky': 'Coffee, quiet walks, and good company.',
    'Kyle': "Take my hand and let's fly!",
    'Mopple': "It's a sweet and magical time!",
    'Riff': "Let's fill the world with rock music!",
}

COLORS = {
    'Blues': '#2464d8', 'Fizz': '#ef4444', 'Glup': '#74c94f', 'Minty': '#39b98f', 'Punk': '#e246bd',
    'Lockby': '#f29d37', 'Carl': '#8a6bff', 'Zippy': '#e86c45', 'Rowdy': '#9f7c51', 'Fazer': '#43a5ff',
    'Rushy': '#2f73d8', 'Zesty': '#ff9a2d', 'Verde': '#77bd2f', 'Mish': '#9067ff', 'Wisky': '#8b6248',
    'Kyle': '#e56b45', 'Mopple': '#ca67d9', 'Riff': '#5d56d6',
}

ORDER = {
    'blocky': ['Blues', 'Fizz', 'Glup', 'Minty', 'Punk', 'Lockby', 'Carl', 'Zippy', 'Rowdy', 'Fazer'],
    'cartoon': ['Rushy', 'Zesty', 'Verde', 'Mish', 'Wisky', 'Kyle', 'Mopple', 'Riff'],
}

def stream_of(obj):
    m = re.search(rb'stream\r?\n(.*?)\r?\nendstream', obj, re.S)
    if not m:
        return None
    s = m.group(1)
    if b'FlateDecode' in obj:
        try:
            return zlib.decompress(s)
        except Exception:
            return None
    return s

def hex_to_text(hexbytes):
    try:
        return bytes.fromhex(hexbytes).decode('utf-16-be', errors='ignore')
    except Exception:
        return ''

def parse_cmap(data):
    cmap = {}
    for block in re.findall(rb'beginbfchar\s*(.*?)\s*endbfchar', data, re.S):
        for src, dst in re.findall(rb'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', block):
            cmap[src.decode().upper()] = hex_to_text(dst.decode())
    for block in re.findall(rb'beginbfrange\s*(.*?)\s*endbfrange', data, re.S):
        for start, end, arr in re.findall(rb'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[(.*?)\]', block, re.S):
            s = int(start, 16); e = int(end, 16)
            vals = re.findall(rb'<([0-9A-Fa-f]+)>', arr)
            for code, val in zip(range(s, e + 1), vals):
                cmap[f'{code:0{len(start)}X}'] = hex_to_text(val.decode())
        cleaned = re.sub(rb'<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*\[.*?\]', b'', block, flags=re.S)
        for start, end, dst in re.findall(rb'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', cleaned):
            s = int(start, 16); e = int(end, 16); d = int(dst, 16)
            for offset, code in enumerate(range(s, e + 1)):
                cmap[f'{code:0{len(start)}X}'] = hex_to_text(f'{d + offset:04X}')
    return cmap

def decode_hex(h, cmap):
    text = ''
    if len(h) % 4 == 0:
        for i in range(0, len(h), 4):
            key = h[i:i + 4]
            text += cmap.get(key, chr(int(key, 16)) if int(key, 16) < 128 else '')
    elif len(h) % 2 == 0:
        for i in range(0, len(h), 2):
            key = h[i:i + 2]
            text += cmap.get(key, chr(int(key, 16)) if int(key, 16) < 128 else '')
    return text

def extract_pdf(path):
    data = path.read_bytes()
    objs = {int(m.group(1)): m.group(2) for m in re.finditer(rb'(\d+)\s+0\s+obj\s*(.*?)\s*endobj', data, re.S)}

    object_cmaps = {}
    for num, obj in objs.items():
        st = stream_of(obj)
        if st and (b'beginbfchar' in st or b'beginbfrange' in st):
            object_cmaps[num] = parse_cmap(st)

    font_obj_to_cmap = {}
    for num, obj in objs.items():
        m = re.search(rb'/ToUnicode\s+(\d+)\s+0\s+R', obj)
        if m:
            font_obj_to_cmap[num] = object_cmaps.get(int(m.group(1)), {})

    font_name_to_obj = {}
    for obj in objs.values():
        for name, ref in re.findall(rb'/(F\d+)\s+(\d+)\s+0\s+R', obj):
            font_name_to_obj[name.decode()] = int(ref)

    lines = []
    for obj in objs.values():
        st = stream_of(obj)
        if not st or b'BT' not in st or b'Tj' not in st:
            continue
        for bt in re.findall(rb'BT\s*(.*?)\s*ET', st, re.S):
            current_font = None
            parts = []
            tokens = re.finditer(rb'/(F\d+)\s+[\d\.]+\s+Tf|<([0-9A-Fa-f]+)>\s*Tj', bt)
            for token in tokens:
                if token.group(1):
                    current_font = token.group(1).decode()
                elif token.group(2):
                    cmap = font_obj_to_cmap.get(font_name_to_obj.get(current_font, -1), {})
                    parts.append(decode_hex(token.group(2).decode().upper(), cmap))
            line = ''.join(parts).strip()
            if line:
                lines.append(line)

    return cleanup_lines(lines)

def cleanup_lines(lines):
    raw = [re.sub(r'\s+', ' ', line.replace('\u00a0', ' ')).strip() for line in lines if line.strip()]
    merged = []
    i = 0
    while i < len(raw):
        line = raw[i]
        if len(line) == 1 and re.match(r'[A-Za-z]', line) and i + 1 < len(raw):
            nxt = raw[i + 1]
            if nxt and nxt[0].islower():
                merged.append(line + nxt)
                i += 2
                continue
        merged.append(line)
        i += 1

    skip_markers = {'Menu', 'TOYHOU.SE', 'FAQ', 'HelpDesk', 'Rules', 'TOS', 'Search', 'View More'}
    cleaned = []
    seen_recent = False
    for line in merged:
        if line == 'Recent Images':
            seen_recent = True
            continue
        if seen_recent:
            continue
        if line in skip_markers or re.match(r'^\d+$', line) or 'Users Online' in line or re.match(r'^\d+:\d+\s*[ap]m$', line):
            continue
        if line and line not in cleaned[-3:]:
            cleaned.append(line)
    return cleaned

def to_paragraphs(lines, name):
    try:
        start = lines.index('Profile') + 1
    except ValueError:
        start = 0
    body = lines[start:]
    stop = len(body)
    for i, line in enumerate(body):
        if line in {'Info', 'Created', 'Creator', 'Favorites', 'About'} or line.startswith('Created '):
            stop = i
            break
    body = body[:stop]

    joined = ' '.join(body)
    joined = re.sub(r'\s+([,!.?:;])', r'\1', joined)
    joined = re.sub(r'([\(])\s+', r'\1', joined)
    joined = re.sub(r'\s+([\)])', r'\1', joined)
    joined = joined.replace('— ', '—')
    joined = re.sub(r'\s+', ' ', joined).strip()
    if not joined:
        return []

    chunks = re.split(r'(?<=[.!?])\s+(?=[A-Z🐶🐱🐺🦊])', joined)
    paragraphs = []
    for chunk in chunks:
        chunk = chunk.strip()
        if not chunk:
            continue
        if len(paragraphs) > 0 and len(chunk) < 28:
            paragraphs[-1] = paragraphs[-1] + ' ' + chunk
        else:
            paragraphs.append(chunk)
    return paragraphs

def write_profile(group, name):
    pdf_path = PDF_ROOT / group / f'{name} on Toyhouse.pdf'
    lines = extract_pdf(pdf_path)
    body = to_paragraphs(lines, name)
    out_dir = OUT_ROOT / group
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f'{name.lower()}.md'
    rel_pdf = f'../introductions pdf/{group}/{name} on Toyhouse.pdf'
    rel_icon = f'../icon/{group}/{name}.png'
    rel_ref = f'../ref sheet/{group}/{name}.png'
    md = [
        '---',
        f'title: "{name}"',
        f'group: "{group}"',
        f'color: "{COLORS[name]}"',
        f'quote: "{QUOTES[name]}"',
        f'icon: "{rel_icon}"',
        f'ref: "{rel_ref}"',
        f'sourcePdf: "{rel_pdf}"',
        '---',
        '',
        f'# {name}',
        '',
        f'> {QUOTES[name]}',
        '',
        '## Profile',
        '',
    ]
    if body:
        md.extend(body)
    else:
        md.append('Profile text could not be extracted automatically yet.')
    md.append('')
    out.write_text('\n\n'.join(md), encoding='utf-8')
    return out, len(body)

def generate_all():
    results = []
    for group, names in ORDER.items():
        for name in names:
            results.append(write_profile(group, name))
    return results

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--all':
        for path, count in generate_all():
            print(f'{path}: {count} paragraphs')
    else:
        path = pathlib.Path(sys.argv[1])
        for line in extract_pdf(path):
            print(line)

