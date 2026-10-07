"""With the local dev server running, verify About with LF and CRLF Markdown."""
from html.parser import HTMLParser
from pathlib import Path
import time
import urllib.request


class AboutParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.labels = []
        self.in_label = False
        self.profiles = self.code_blocks = self.friend_buttons = self.ask_forms = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = attrs.get('class', '').split()
        self.profiles += 'about-profile-table' in classes
        self.code_blocks += 'md-code-block' in classes
        self.friend_buttons += 'about-friend-button' in classes
        self.ask_forms += 'data-ask-form' in attrs
        if tag == 'dt':
            self.in_label = True

    def handle_endtag(self, tag):
        if tag == 'dt':
            self.in_label = False

    def handle_data(self, data):
        if self.in_label and data.strip():
            self.labels.append(data.strip())


markdown = Path(__file__).resolve().parents[1] / 'src/content/about/about.md'
original = markdown.read_bytes()
lf = original.replace(b'\r\n', b'\n').replace(b'\r', b'\n')
expected = {'Name', 'Species', 'Dimension', 'Role', 'Creates', 'Art style', 'Languages', 'Current project', 'Birthday', 'Gender', 'Favorite games', 'Software', 'Likes', 'Dislikes'}
try:
    for name, content in [('LF', lf), ('CRLF', lf.replace(b'\n', b'\r\n'))]:
        markdown.write_bytes(content)
        time.sleep(0.5)
        html = urllib.request.urlopen('http://127.0.0.1:4321/about.html', timeout=30).read().decode('utf-8')
        parser = AboutParser()
        parser.feed(html)
        assert set(parser.labels) == expected, (name, parser.labels)
        assert len(parser.labels) == 14
        assert (parser.profiles, parser.code_blocks, parser.friend_buttons, parser.ask_forms) == (1, 1, 3, 0)
        assert '[ask-box]' not in html
        print(f'{name}: all 14 profile fields, code block, friend buttons, and removed ask form verified.')
finally:
    markdown.write_bytes(original)
