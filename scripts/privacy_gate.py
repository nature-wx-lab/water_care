#!/usr/bin/env python3
"""公開repo用privacy gate。検知値そのものは出力しない。"""
from __future__ import annotations
import os,re,subprocess,sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
ALLOWED_EMAILS={'nature-wx-lab@users.noreply.github.com','41898282+github-actions[bot]@users.noreply.github.com'}
TEXT_SUFFIXES={'.html','.css','.js','.mjs','.py','.json','.geojson','.csv','.md','.txt','.yml','.yaml','.xml'}
FORBIDDEN_FILES={'.env','.DS_Store'}
FORBIDDEN_PARTS={'state','fixtures','screenshots','logs','__pycache__'}
PATTERNS=[
 re.compile(r'/Users/|[A-Za-z]:\\\\|private/var'),
 re.compile(r'github_pat_|ghp_[A-Za-z0-9]+'),
 re.compile(r'(?i)(token|secret|password|api[ _-]?key)\s*[:=]\s*["\'][^"\']+["\']'),
 re.compile(r'[\w.+-]+@[\w-]+\.[\w.-]+'),
]

def fail(items):
    for path,line,kind in items: print(f'privacy gate: {path}:{line} [{kind}]',file=sys.stderr)
    raise SystemExit(1)

def scan_files():
    findings=[];deny=[x for x in os.environ.get('PRIVACY_DENYLIST','').splitlines() if x.strip()]
    for path in ROOT.rglob('*'):
        rel=path.relative_to(ROOT)
        if '.git' in rel.parts: continue
        if path.is_dir(): continue
        if path.name in FORBIDDEN_FILES or any(part in FORBIDDEN_PARTS for part in rel.parts):
            findings.append((rel,0,'forbidden-file'));continue
        if path.suffix.lower() not in TEXT_SUFFIXES: continue
        try: lines=path.read_text(errors='strict').splitlines()
        except (UnicodeDecodeError,OSError): continue
        for number,text in enumerate(lines,1):
            if rel==Path('scripts/privacy_gate.py') and 12<=number<=16: continue
            for pattern in PATTERNS:
                match=pattern.search(text)
                if not match: continue
                if '@' in match.group(0) and match.group(0) in ALLOWED_EMAILS: continue
                findings.append((rel,number,'pattern'))
            if any(value in text for value in deny): findings.append((rel,number,'denylist'))
    return findings

def scan_history():
    if not (ROOT/'.git').exists(): return []
    result=subprocess.run(['git','-C',str(ROOT),'log','--all','--format=%H%x09%ae%x09%ce'],capture_output=True,text=True,check=True)
    findings=[]
    for row in result.stdout.splitlines():
        commit,author,committer=row.split('\t')
        if author not in ALLOWED_EMAILS or committer not in ALLOWED_EMAILS: findings.append((commit[:12],0,'git-identity'))
    return findings

findings=scan_files()+scan_history()
if findings: fail(sorted(set(findings),key=lambda x:(str(x[0]),x[1],x[2])))
print('privacy gate passed: files and reachable history')
