"""
Builds a completely self-contained, standalone single-file HTML version of Scrobble Deck.
This file can be opened directly in any browser (via file:// or http://) with zero server,
zero dependencies, and zero build step.
"""
import re
import os

def build():
    root = os.path.dirname(os.path.abspath(__file__))
    static_dir = os.path.join(root, "static")

    with open(os.path.join(static_dir, "index.html"), "r", encoding="utf-8") as f:
        html = f.read()

    with open(os.path.join(static_dir, "css", "style.css"), "r", encoding="utf-8") as f:
        css = f.read()

    # Inline CSS
    css_tag = f"<style>\n{css}\n</style>"
    html = html.replace('<link rel="stylesheet" href="css/style.css">', css_tag)

    # Order of JS files for correct declaration dependency
    js_files = ["utils.js", "lastfm.js", "player.js", "loved.js", "library.js", "artist.js", "main.js"]
    combined_js = []

    for fname in js_files:
        fpath = os.path.join(static_dir, "js", fname)
        with open(fpath, "r", encoding="utf-8") as f:
            code = f.read()

        # Strip multi-line and single-line import statements
        code = re.sub(r'import\s+[\s\S]*?from\s+["\'][^"\']+["\'];?', '', code)
        # Strip export keywords
        code = re.sub(r'^\s*export\s+(const|let|var|function|class)\s+', r'\1 ', code, flags=re.MULTILINE)
        code = re.sub(r'^\s*export\s*\{[\s\S]*?\};?', '', code, flags=re.MULTILINE)

        combined_js.append(f"// ─── Module: {fname} ───\n" + code.strip())

    all_js = "\n\n".join(combined_js)
    script_tag = f"<script>\n(async function() {{\n{all_js}\n}})();\n</script>"

    # Replace script tag
    html = html.replace('<script type="module" src="js/main.js"></script>', script_tag)

    out_path = os.path.join(root, "ScrobbleDeck-Standalone.html")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Successfully generated: {out_path} ({len(html):,} bytes)")

if __name__ == "__main__":
    build()
