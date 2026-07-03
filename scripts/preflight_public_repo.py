#!/usr/bin/env python3
"""公開repo作成前ゲート1。初回commit前のidentityと安全装置を確認する。"""
from __future__ import annotations
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
ALLOWED={'nature-wx-lab@users.noreply.github.com'}
required=[ROOT/'.github/workflows/privacy-gate.yml',ROOT/'scripts/privacy_gate.py',ROOT/'.gitignore']
missing=[str(path.relative_to(ROOT)) for path in required if not path.exists()]
email=subprocess.check_output(['git','config','user.email'],text=True).strip()
name=subprocess.check_output(['git','config','user.name'],text=True).strip()
errors=[]
if email not in ALLOWED: errors.append('git user.email is not the approved public noreply identity')
if name!='nature-wx-lab': errors.append('git user.name is not nature-wx-lab')
if missing: errors.append('missing safety files: '+', '.join(missing))
if errors: raise SystemExit('public repo preflight failed:\n'+'\n'.join(errors))
print('public repo preflight passed: identity and privacy workflow are ready')
print('manual account checks still required before repo creation: email privacy and push blocking')
