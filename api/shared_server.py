"""Shared local-only booking test data allocator. Python 3.9+; standard library only."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import sqlite3, json, re, threading, secrets
from pathlib import Path
DB=Path(__file__).with_name('shared_test_profiles.sqlite3')
LOCK=threading.Lock()
FIRST=['Alex','Jamie','Taylor','Morgan','Jordan','Casey','Robin','Sam','Avery','Riley']
LAST=['Sample','Example','Tester','Demo','Testperson']
# Fictional number ranges designated for drama/testing in these countries.
# Other countries: leave blank rather than risk a real subscriber.
def test_phone(country):
    c=country.lower()
    if re.search(r'\+44\b|united kingdom|great britain|\buk\b',c):
        return '7700900'+str(secrets.randbelow(1000)).zfill(3)
    if re.search(r'\+1\b|united states|canada|\busa\b',c):
        return '20255501'+str(secrets.randbelow(100)).zfill(2)
    return ''
def alias(local, index):
    out=local[0]
    for i,ch in enumerate(local[1:]):
        if index & (1<<i):out+='.'
        out+=ch
    return out+'@gmail.com'
def allocate(data):
    gmail=str(data.get('gmail','')).lower().strip()
    if not re.fullmatch(r'[a-z0-9.]+@(?:gmail|googlemail)\.com',gmail):raise ValueError('Enter a valid personal Gmail address.')
    local=gmail.split('@')[0].replace('.','')
    if len(local)<2:raise ValueError('Gmail username is too short.')
    cap=1<<(len(local)-1)
    if cap>10000000:cap=10000000
    names=[x.strip() for x in str(data.get('names','')).splitlines() if len(x.strip().split())>=2]
    mode=data.get('nameMode')
    if names: mode='list'
    if mode=='list' and not names:raise ValueError('Enter at least one full name.')
    with LOCK, sqlite3.connect(DB) as db:
        db.execute('BEGIN IMMEDIATE')
        used_aliases={r[0] for r in db.execute('SELECT email FROM used')}
        used_names={r[0] for r in db.execute('SELECT full FROM used')}
        if mode=='list':
            available=[x for x in dict.fromkeys(names) if x not in used_names]
            if not available:raise ValueError('All saved names have already been used in the shared database.')
            full=secrets.choice(available)
        else:
            available=[f'{a} {b}' for a in FIRST for b in LAST if f'{a} {b}' not in used_names]
            if not available:raise ValueError('Sample name pool exhausted. Import more names.')
            full=secrets.choice(available)
        # scan aliases deterministically; the UNIQUE index also prevents concurrent reuse.
        email=None
        for idx in range(cap):
            candidate=alias(local,idx)
            if candidate not in used_aliases:email=candidate;break
        if not email:raise ValueError('All available Gmail dot aliases have been used.')
        phone=str(data.get('phone','')).strip() or test_phone(str(data.get('country','')))
        if phone and not re.fullmatch(r'[0-9 +()\-]{6,22}',phone):raise ValueError('Phone must contain only phone-number characters.')
        if phone:
            used_phones={r[0] for r in db.execute('SELECT phone FROM used WHERE phone != ""')}
            if data.get('phone'):
                if phone in used_phones: raise ValueError('This phone was already used. Supply another authorized number.')
            else:
                for _ in range(500):
                    if phone not in used_phones: break
                    phone=test_phone(str(data.get('country','')))
                else: phone=''
        db.execute('INSERT INTO used(full,email,phone) VALUES (?,?,?)',(full,email,phone))
        db.commit()
        return {'full':full,'email':email,'phone':phone}
class Handler(BaseHTTPRequestHandler):
    def send(self,code,obj):
        b=json.dumps(obj).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Access-Control-Allow-Origin','*');self.send_header('Access-Control-Allow-Headers','Content-Type');self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
    def do_OPTIONS(self):self.send(200,{})
    def do_GET(self):self.send(200,{'ok':True}) if self.path=='/health' else self.send(404,{'error':'Not found'})
    def do_POST(self):
        try:
            size=int(self.headers.get('Content-Length',0))
            if size>1000000:raise ValueError('Request too large')
            d=json.loads(self.rfile.read(size))
            if self.path=='/allocate':self.send(200,allocate(d))
            elif self.path=='/reset' and d.get('confirm')=='ERASE_TEST_HISTORY':
                with LOCK,sqlite3.connect(DB) as db:db.execute('DELETE FROM used');db.commit()
                self.send(200,{'ok':True})
            else:self.send(404,{'error':'Not found'})
        except (ValueError,sqlite3.Error) as e:self.send(400,{'error':str(e)})
        except Exception:self.send(500,{'error':'Unexpected server error'})
    def log_message(self,*args):pass
if __name__=='__main__':
    with sqlite3.connect(DB) as db:
        db.execute('CREATE TABLE IF NOT EXISTS used (id INTEGER PRIMARY KEY, full TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT NOT NULL DEFAULT "", created_at TEXT DEFAULT CURRENT_TIMESTAMP)')
    print('Shared AutoFill server running at http://127.0.0.1:8765 (Ctrl+C to stop)',flush=True)
    ThreadingHTTPServer(('127.0.0.1',8765),Handler).serve_forever()
