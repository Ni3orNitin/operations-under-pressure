'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://ops:ops@localhost:5432/ops' });
const PORT = Number(process.env.PORT || 3000);
const transitions = { open:['in_progress'], in_progress:['open','awaiting_approval'], awaiting_approval:['resolved'], resolved:['closed'] };
class HttpError extends Error { constructor(status,message,detail) { super(message); this.status=status; this.detail=detail; } }
const json = (res,status,data) => { res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(data)); };
async function body(req) { let s=''; for await (const chunk of req) { s+=chunk; if (s.length>1_000_000) throw new HttpError(413,'Request too large'); } try { return s ? JSON.parse(s) : {}; } catch { throw new HttpError(400,'Invalid JSON'); } }
async function actor(req) {
 const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 if (!token) throw new HttpError(401,'Sign in required');
 const {rows}=await pool.query('SELECT id,name,email FROM users WHERE token=$1',[token]);
 if (!rows[0]) throw new HttpError(401,'Invalid token'); return rows[0];
}
async function membership(db,userId,teamId) {
 const {rows}=await db.query('SELECT role FROM memberships WHERE user_id=$1 AND team_id=$2',[userId,teamId]);
 if (!rows[0]) throw new HttpError(403,'You are not a member of this team'); return rows[0].role;
}
async function itemFor(db,id,userId) {
 const {rows}=await db.query('SELECT i.* FROM work_items i JOIN memberships m ON m.team_id=i.team_id AND m.user_id=$2 WHERE i.id=$1',[id,userId]);
 if (!rows[0]) throw new HttpError(404,'Work item not found'); return rows[0];
}
const canWrite = (role) => role==='Member'||role==='Lead'||role==='Admin';
async function event(db,itemId,actorId,kind,bodyText='',changes={}) { await db.query('INSERT INTO activity_events(item_id,actor_id,kind,body,changes) VALUES($1,$2,$3,$4,$5)',[itemId,actorId,kind,bodyText,changes]); }
async function withTx(fn) { const c=await pool.connect(); try { await c.query('BEGIN'); const out=await fn(c); await c.query('COMMIT'); return out; } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } }
function cursorEncode(r) { return Buffer.from(JSON.stringify([r.created_at,r.id])).toString('base64url'); }
async function route(req,res) {
 const u=new URL(req.url,'http://localhost'); const p=u.pathname; const method=req.method;
 if(method==='GET' && p==='/api/health') return json(res,200,{ok:true});
 if(method==='POST' && p==='/api/login'){const b=await body(req);const {scryptSync,timingSafeEqual}=require('node:crypto');const {rows}=await pool.query('SELECT id,name,email,token,password_hash FROM users WHERE email=$1',[String(b.email||'').toLowerCase()]);if(!rows[0])throw new HttpError(401,'Email or password is incorrect');const expected=Buffer.from(rows[0].password_hash,'hex'),actual=scryptSync(String(b.password||''),'ops-demo-salt',32);if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new HttpError(401,'Email or password is incorrect');return json(res,200,{token:rows[0].token,user:{id:rows[0].id,name:rows[0].name,email:rows[0].email}});}
 if(method==='GET' && p==='/api/users') { const a=await actor(req); const {rows}=await pool.query('SELECT t.id team_id,t.name team_name,m.role FROM memberships m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1 ORDER BY t.name',[a.id]); return json(res,200,{user:a,teams:rows}); }
 if(method==='GET' && p==='/api/me') { const a=await actor(req); const {rows}=await pool.query('SELECT t.id team_id,t.name team_name,m.role FROM memberships m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1 ORDER BY t.name',[a.id]); return json(res,200,{user:a,teams:rows}); }
 if(method==='GET' && p==='/api/items') {
  const a=await actor(req), team=u.searchParams.get('team'); if(!team) throw new HttpError(400,'team is required'); await membership(pool,a.id,team);
  const clauses=['i.team_id=$1'], vals=[team]; const add=(sql,v)=>{vals.push(v);clauses.push(sql.replaceAll('?',`$${vals.length}`));};
  const status=u.searchParams.get('status'),priority=u.searchParams.get('priority'),assignee=u.searchParams.get('assignee'),view=u.searchParams.get('view'),q=u.searchParams.get('q'),type=u.searchParams.get('type');
  if(status&&status!=='all')add('i.status=?',status); if(priority&&priority!=='all')add('i.priority=?',priority); if(type&&type!=='all')add('i.type=?',type);
  if(view==='mine')add('i.assignee_id=?',a.id); else if(view==='unassigned_urgent'){clauses.push("i.assignee_id IS NULL AND i.priority='urgent'");} else if(view==='approval'){clauses.push("i.status='awaiting_approval'");}
  else if(assignee&&assignee!=='all')add('i.assignee_id=?',assignee); else if(assignee==='unassigned')clauses.push('i.assignee_id IS NULL');
  if(q){vals.push(q); clauses.push(`to_tsvector('english',i.title || ' ' || i.description) @@ plainto_tsquery('english',$${vals.length})`);}
  const pageSize=Math.max(1,Math.min(100,Number(u.searchParams.get('limit')||20))); const cursor=u.searchParams.get('cursor');
  if(cursor){try{const [date,id]=JSON.parse(Buffer.from(cursor,'base64url').toString()); vals.push(date,id);clauses.push(`(i.created_at,i.id)<($${vals.length-1},$${vals.length})`);}catch{throw new HttpError(400,'Invalid cursor');}}
  vals.push(pageSize+1); const {rows}=await pool.query(`SELECT i.*,u.name assignee_name FROM work_items i LEFT JOIN users u ON u.id=i.assignee_id WHERE ${clauses.join(' AND ')} ORDER BY i.created_at DESC,i.id DESC LIMIT $${vals.length}`,vals);
  const more=rows.length>pageSize, items=rows.slice(0,pageSize); return json(res,200,{items,nextCursor:more?cursorEncode(items[items.length-1]):null});
 }
 let m=p.match(/^\/api\/items\/([^/]+)(?:\/(activity|claim|transition|comments))?$/);
 if(m){ const id=decodeURIComponent(m[1]),sub=m[2]; const a=await actor(req);
  if(method==='GET'&&!sub){const i=await itemFor(pool,id,a.id); const {rows:activity}=await pool.query('SELECT e.*,u.name actor_name FROM activity_events e JOIN users u ON u.id=e.actor_id WHERE e.item_id=$1 ORDER BY e.id DESC LIMIT 100',[id]); return json(res,200,{item:i,activity});}
  if(method==='GET'&&sub==='activity'){await itemFor(pool,id,a.id);const {rows}=await pool.query('SELECT e.*,u.name actor_name FROM activity_events e JOIN users u ON u.id=e.actor_id WHERE e.item_id=$1 ORDER BY e.id DESC LIMIT 100',[id]);return json(res,200,{activity:rows});}
  if(method==='POST'&&sub==='claim'){
   const result=await withTx(async db=>{const i=await itemFor(db,id,a.id),role=await membership(db,a.id,i.team_id);if(!canWrite(role))throw new HttpError(403,'Your role cannot claim work');
    const {rows}=await db.query("UPDATE work_items SET assignee_id=$1,version=version+1,updated_at=now() WHERE id=$2 AND assignee_id IS NULL AND status NOT IN ('resolved','closed') RETURNING *",[a.id,id]); if(!rows[0])throw new HttpError(409,'This item is already claimed or no longer claimable');
    await event(db,id,a.id,'assignment','Claimed by '+a.name,{from:null,to:a.id});await db.query('INSERT INTO outbox_jobs(kind,payload) VALUES($1,$2)', ['assignment_changed',{itemId:id,assigneeId:a.id}]);return rows[0];});return json(res,200,{item:result});
  }
  if(method==='POST'&&sub==='transition'){
   const b=await body(req), version=Number(b.version), next=b.status;
   const result=await withTx(async db=>{const i=await itemFor(db,id,a.id),role=await membership(db,a.id,i.team_id);if(!canWrite(role))throw new HttpError(403,'Your role cannot change workflow');if(!transitions[i.status]?.includes(next))throw new HttpError(400,`Transition ${i.status} → ${next} is not allowed`);if(i.status==='awaiting_approval'&&role!=='Lead')throw new HttpError(403,'Only a team Lead can approve');
    const {rows}=await db.query('UPDATE work_items SET status=$1,version=version+1,updated_at=now() WHERE id=$2 AND version=$3 RETURNING *',[next,id,version]);if(!rows[0])throw new HttpError(409,'This item changed. Reload and try again.');await event(db,id,a.id,'status_changed',`Moved ${i.status} → ${next}`,{from:i.status,to:next});if(next==='awaiting_approval')await db.query('INSERT INTO outbox_jobs(kind,payload) VALUES($1,$2)',['approval_requested',{itemId:id,teamId:i.team_id}]);return rows[0];});return json(res,200,{item:result});
  }
  if(method==='POST'&&sub==='comments'){
   const b=await body(req),text=String(b.body||'').trim();if(!text||text.length>3000)throw new HttpError(400,'Comment must be 1–3000 characters');
   const i=await itemFor(pool,id,a.id),role=await membership(pool,a.id,i.team_id);if(!canWrite(role))throw new HttpError(403,'Your role cannot comment');await withTx(db=>event(db,id,a.id,'comment',text));return json(res,201,{ok:true});
  }
  if(method==='PATCH'&&!sub){
   const b=await body(req),version=Number(b.version); const result=await withTx(async db=>{const i=await itemFor(db,id,a.id),role=await membership(db,a.id,i.team_id);if(!canWrite(role))throw new HttpError(403,'Your role cannot edit work');const fields={},changes={};for(const k of ['title','description','priority','assignee_id','due_at'])if(Object.hasOwn(b,k)&&b[k]!==i[k]){fields[k]=b[k];changes[k]={from:i[k],to:b[k]};}if(!Object.keys(fields).length) return i;
    if(role==='Member'&&Object.hasOwn(fields,'assignee_id')&&fields.assignee_id!==a.id)throw new HttpError(403,'Members can assign work only to themselves');
    if(fields.assignee_id){const {rows:member}=await db.query('SELECT 1 FROM memberships WHERE user_id=$1 AND team_id=$2',[fields.assignee_id,i.team_id]);if(!member[0])throw new HttpError(400,'Assignee must belong to the same team');}
    if(fields.priority&&!['low','normal','high','urgent'].includes(fields.priority))throw new HttpError(400,'Invalid priority'); if(fields.title&&(!String(fields.title).trim()||String(fields.title).length>160))throw new HttpError(400,'Title must be 1–160 characters');
    const keys=Object.keys(fields), values=keys.map(k=>fields[k]);const setters=keys.map((k,n)=>`${k}=$${n+1}`);values.push(id,version);const {rows}=await db.query(`UPDATE work_items SET ${setters.join(',')},version=version+1,updated_at=now() WHERE id=$${values.length-1} AND version=$${values.length} RETURNING *`,values);if(!rows[0])throw new HttpError(409,'This item changed. Reload and try again.');for(const k of Object.keys(changes))await event(db,id,a.id,k==='priority'?'priority_changed':k==='assignee_id'?'assignment':'item_edited',`${k} updated`,{[k]:changes[k]});return rows[0];});return json(res,200,{item:result});
  }
 }
 if(method==='POST'&&p==='/api/items'){
  const a=await actor(req),b=await body(req),key=req.headers['idempotency-key'];if(!key||String(key).length>200)throw new HttpError(400,'Idempotency-Key header required');
  const result=await withTx(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[a.id,key]);const {rows:existing}=await db.query('SELECT response FROM idempotency_keys WHERE actor_id=$1 AND key=$2',[a.id,key]);if(existing[0]){await membership(db,a.id,existing[0].response.item.team_id);return existing[0].response;}
   const team=String(b.team_id||'');const role=await membership(db,a.id,team);if(!canWrite(role))throw new HttpError(403,'Your role cannot create work');const title=String(b.title||'').trim();if(!title||title.length>160)throw new HttpError(400,'Title must be 1–160 characters');const type=b.type||'task',priority=b.priority||'normal';if(!['incident','customer_issue','payment','compliance','task'].includes(type)||!['low','normal','high','urgent'].includes(priority))throw new HttpError(400,'Invalid type or priority');
   if(b.assignee_id){const {rows:mem}=await db.query('SELECT 1 FROM memberships WHERE user_id=$1 AND team_id=$2',[b.assignee_id,team]);if(!mem[0])throw new HttpError(400,'Assignee must belong to the same team');}
   const id=require('node:crypto').randomUUID();const {rows}=await db.query('INSERT INTO work_items(id,title,description,type,priority,status,team_id,assignee_id,created_by,due_at) VALUES($1,$2,$3,$4,$5,\'open\',$6,$7,$8,$9) RETURNING *',[id,title,String(b.description||''),type,priority,team,b.assignee_id||null,a.id,b.due_at||null]);await event(db,id,a.id,'created','Work item created',{status:'open',priority});const response={item:rows[0]};await db.query('INSERT INTO idempotency_keys(actor_id,key,response) VALUES($1,$2,$3)',[a.id,key,response]);if(b.assignee_id)await db.query('INSERT INTO outbox_jobs(kind,payload) VALUES($1,$2)',['assignment_changed',{itemId:id,assigneeId:b.assignee_id}]);return response;});return json(res,201,result);
 }
 if(method==='GET'&&p==='/api/teams') {const a=await actor(req);const {rows}=await pool.query('SELECT t.id,t.name,m.role FROM teams t JOIN memberships m ON m.team_id=t.id WHERE m.user_id=$1 ORDER BY t.name',[a.id]);return json(res,200,{teams:rows});}
 if(method==='GET'&&p==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(fs.readFileSync(path.join(__dirname,'../public/index.html')));}
 if(method==='GET'&&p.startsWith('/')){const f=path.join(__dirname,'../public',path.basename(p));if(fs.existsSync(f)){res.writeHead(200,{'content-type':f.endsWith('.js')?'text/javascript':'text/css'});return res.end(fs.readFileSync(f));}}
 throw new HttpError(404,'Route not found');
}
const server=http.createServer(async(req,res)=>{try{await route(req,res);}catch(e){json(res,e.status||500,{error:e.message||'Internal server error',detail:e.detail});if(!e.status)console.error(e);}});
if(require.main===module)server.listen(PORT,()=>console.log(`Operations Under Pressure listening on ${PORT}`));
module.exports={transitions,canWrite,cursorEncode,server,pool};
