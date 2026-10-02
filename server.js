'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(ROOT, 'uploads');
const DB_PATH = path.join(DATA, 'db.json');
const MAX_BODY = 40 * 1024 * 1024;
const TOKEN_DAYS = 30;

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

const empty = () => ({
  users: [],
  sessions: [],
  posts: [],
  communities: [],
  lists: [],
  notifications: [],
  seq: 1
});

let db = empty();
try {
  if (fs.existsSync(DB_PATH)) db = Object.assign(empty(), JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
} catch (err) {
  db = empty();
}

let writing = Promise.resolve();
function save() {
  const snap = JSON.stringify(db);
  writing = writing.then(() => fs.promises.writeFile(DB_PATH, snap)).catch(() => {});
  return writing;
}

const clients = new Set();

function nid() {
  db.seq += 1;
  return db.seq;
}
function now() { return Date.now(); }
function publicUser(u) {
  if (!u) return null;
  const { passwordHash, salt, ...rest } = u;
  return rest;
}
function userById(id) { return db.users.find(u => u.id === id); }
function userByHandle(handle) { return db.users.find(u => u.handle === String(handle || '').toLowerCase()); }
function postById(id) { return db.posts.find(p => p.id === Number(id)); }

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}
function makeToken() { return crypto.randomBytes(24).toString('hex'); }

function auth(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const session = db.sessions.find(s => s.token === token && s.exp > now());
  if (!session) return null;
  return userById(session.userId);
}

function notify(userId, type, fromId, postId, text) {
  if (!userId || userId === fromId) return;
  const note = { id: nid(), userId, type, fromId, postId: postId || null, text: text || '', time: now(), read: false };
  db.notifications.push(note);
  push(userId, { type: 'notification', note: hydrateNote(note) });
}

function hydrateNote(n) {
  const from = userById(n.fromId);
  return { ...n, from: from ? { id: from.id, name: from.name, handle: from.handle, avatar: from.avatar } : null };
}

function push(userId, event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    if (client.userId === userId) {
      try { client.res.write(payload); } catch (err) { clients.delete(client); }
    }
  }
}
function broadcast(event, exceptId) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    if (client.userId === exceptId) continue;
    try { client.res.write(payload); } catch (err) { clients.delete(client); }
  }
}

function scorePost(post, me) {
  const ageH = Math.max(0.05, (now() - post.time) / 3600000);
  const decay = Math.exp(-ageH / 18);
  const social = 1 + post.likes.length * 2 + post.replies * 3 + post.reposts.length * 1.5 + Math.log10(post.views + 1);
  let boost = 1;
  if (me) {
    if (me.following.includes(post.authorId)) boost += 1.4;
    const author = userById(post.authorId);
    const tags = (post.content.match(/#[^\s#]+/g) || []).map(t => t.slice(1).toLowerCase());
    const overlap = tags.filter(t => (me.interests || []).includes(t)).length;
    boost += overlap * 0.8;
    if (post.communityId && (me.communities || []).includes(post.communityId)) boost += 0.7;
    if (author && (author.interests || []).some(t => (me.interests || []).includes(t))) boost += 0.3;
  }
  if (post.media && post.media.some(m => m.type === 'video')) boost += 0.25;
  return decay * social * boost;
}

function hydratePost(p, me) {
  const author = userById(p.authorId);
  const quoted = p.quoteId ? postById(p.quoteId) : null;
  return {
    ...p,
    author: publicUser(author),
    liked: me ? p.likes.includes(me.id) : false,
    reposted: me ? p.reposts.includes(me.id) : false,
    bookmarked: me ? p.bookmarks.includes(me.id) : false,
    likeCount: p.likes.length,
    repostCount: p.reposts.length,
    quote: quoted ? { id: quoted.id, content: quoted.content, author: publicUser(userById(quoted.authorId)), media: quoted.media } : null
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buf, boundary) {
  const parts = [];
  const sep = Buffer.from('--' + boundary);
  let start = buf.indexOf(sep) + sep.length;
  while (start < buf.length) {
    if (buf.slice(start, start + 2).toString() === '--') break;
    if (buf.slice(start, start + 2).toString() === '\r\n') start += 2;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd < 0) break;
    const header = buf.slice(start, headEnd).toString('utf8');
    let bodyStart = headEnd + 4;
    let next = buf.indexOf(sep, bodyStart);
    if (next < 0) break;
    let bodyEnd = next - 2;
    const name = (header.match(/name="([^"]+)"/) || [])[1];
    const filename = (header.match(/filename="([^"]*)"/) || [])[1];
    const type = (header.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || '';
    parts.push({ name, filename, type: type.trim(), data: buf.slice(bodyStart, bodyEnd) });
    start = next + sep.length;
  }
  return parts;
}

function send(res, status, data, headers) {
  const body = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  res.writeHead(status, Object.assign({
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }, headers));
  res.end(body);
}
function sendJson(res, status, data) { send(res, status, data); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.svg': 'image/svg+xml' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const me = auth(req);

  if (url.pathname === '/api/stream' && req.method === 'GET') {
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
    const client = { userId: me.id, res };
    clients.add(client);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (err) { clearInterval(ping); } }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(client); });
    return;
  }

  if (url.pathname.startsWith('/uploads/')) {
    const file = path.basename(url.pathname);
    const full = path.join(UPLOADS, file);
    if (!file || !fs.existsSync(full)) return send(res, 404, 'not found');
    const stat = fs.statSync(full);
    const ext = path.extname(file).toLowerCase();
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : stat.size - 1;
      res.writeHead(206, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1
      });
      fs.createReadStream(full, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(full).pipe(res);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      await route(req, res, url, me);
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message || 'server error' });
    }
    return;
  }

  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.normalize(path.join(PUBLIC, filePath));
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    const index = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(index).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

async function route(req, res, url, me) {
  const p = url.pathname;

  if (p === '/api/register' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const handle = String(body.handle || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
    const name = String(body.name || '').trim().slice(0, 40);
    const password = String(body.password || '');
    if (!handle || handle.length < 3) throw Object.assign(new Error('账号只能用 3-20 位英文、数字或下划线'), { status: 400 });
    if (password.length < 6) throw Object.assign(new Error('密码至少 6 位'), { status: 400 });
    if (userByHandle(handle)) throw Object.assign(new Error('账号已存在'), { status: 409 });
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: nid(), handle, name: name || handle, bio: '', location: '', avatar: '', banner: '',
      passwordHash: hashPassword(password, salt), salt,
      following: [], communities: [], interests: [], createdAt: now()
    };
    db.users.push(user);
    const token = makeToken();
    db.sessions.push({ token, userId: user.id, exp: now() + TOKEN_DAYS * 86400000 });
    save();
    return sendJson(res, 200, { token, user: publicUser(user) });
  }

  if (p === '/api/login' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const user = userByHandle(body.handle);
    if (!user || hashPassword(String(body.password || ''), user.salt) !== user.passwordHash) {
      throw Object.assign(new Error('账号或密码错误'), { status: 401 });
    }
    const token = makeToken();
    db.sessions.push({ token, userId: user.id, exp: now() + TOKEN_DAYS * 86400000 });
    save();
    return sendJson(res, 200, { token, user: publicUser(user) });
  }

  if (p === '/api/me' && req.method === 'GET') {
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    return sendJson(res, 200, { user: publicUser(me) });
  }

  if (p === '/api/me' && req.method === 'PATCH') {
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    ['name', 'bio', 'location', 'avatar', 'banner'].forEach(k => {
      if (body[k] != null) me[k] = String(body[k]).slice(0, 280);
    });
    if (Array.isArray(body.interests)) me.interests = body.interests.map(t => String(t).toLowerCase().replace(/^#/, '')).slice(0, 12);
    save();
    return sendJson(res, 200, { user: publicUser(me) });
  }

  if (p === '/api/upload' && req.method === 'POST') {
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    const ctype = req.headers['content-type'] || '';
    const boundary = (ctype.match(/boundary=(.+)$/) || [])[1];
    if (!boundary) throw Object.assign(new Error('需要 multipart'), { status: 400 });
    const parts = parseMultipart(await readBody(req), boundary);
    const media = [];
    for (const part of parts) {
      if (!part.filename) continue;
      const okImage = /^image\/(jpeg|png|webp|gif)$/.test(part.type);
      const okVideo = /^video\/(mp4|webm)$/.test(part.type);
      if (!okImage && !okVideo) throw Object.assign(new Error('只接受 jpg/png/webp/gif/mp4/webm'), { status: 400 });
      if (part.data.length > 32 * 1024 * 1024) throw Object.assign(new Error('单文件不超过 32MB'), { status: 400 });
      const ext = okVideo ? (part.type.includes('webm') ? '.webm' : '.mp4') : (part.type.includes('png') ? '.png' : part.type.includes('webp') ? '.webp' : part.type.includes('gif') ? '.gif' : '.jpg');
      const name = crypto.randomBytes(12).toString('hex') + ext;
      fs.writeFileSync(path.join(UPLOADS, name), part.data);
      media.push({ type: okVideo ? 'video' : 'image', url: '/uploads/' + name });
    }
    return sendJson(res, 200, { media });
  }

  if (p === '/api/posts' && req.method === 'POST') {
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const content = String(body.content || '').trim().slice(0, 500);
    const media = Array.isArray(body.media) ? body.media.slice(0, 4) : [];
    if (!content && !media.length) throw Object.assign(new Error('内容为空'), { status: 400 });
    if (body.communityId && !db.communities.some(c => c.id === Number(body.communityId) && c.members.includes(me.id))) {
      throw Object.assign(new Error('不在该社群'), { status: 403 });
    }
    const post = {
      id: nid(), authorId: me.id, content, media, communityId: body.communityId ? Number(body.communityId) : null,
      replyTo: body.replyTo ? Number(body.replyTo) : null, quoteId: body.quoteId ? Number(body.quoteId) : null,
      poll: body.poll && body.poll.question && Array.isArray(body.poll.options) ? {
        question: String(body.poll.question).slice(0, 120),
        options: body.poll.options.slice(0, 4).map(t => ({ text: String(t).slice(0, 40), votes: [] }))
      } : null,
      likes: [], reposts: [], bookmarks: [], replies: 0, views: 0, time: now()
    };
    db.posts.push(post);
    if (post.replyTo) {
      const parent = postById(post.replyTo);
      if (parent) { parent.replies += 1; notify(parent.authorId, 'reply', me.id, post.id, content); }
    }
    const tags = content.match(/#[^\s#]+/g) || [];
    tags.forEach(tag => {
      const key = tag.slice(1).toLowerCase();
      if (!me.interests.includes(key)) me.interests.push(key);
      me.interests = me.interests.slice(-12);
    });
    save();
    const hydrated = hydratePost(post, me);
    broadcast({ type: 'post', post: hydrated }, me.id);
    return sendJson(res, 200, { post: hydrated });
  }

  if (p === '/api/feed' && req.method === 'GET') {
    const mode = url.searchParams.get('mode') || 'forYou';
    const q = (url.searchParams.get('q') || '').toLowerCase();
    let list = db.posts.filter(post => !post.replyTo);
    if (q) list = db.posts.filter(post => post.content.toLowerCase().includes(q) || (userById(post.authorId)?.handle || '').includes(q));
    else if (mode === 'following') {
      if (!me) return sendJson(res, 401, { error: '请先登录' });
      const ids = new Set([me.id, ...me.following]);
      list = list.filter(post => ids.has(post.authorId));
    } else if (mode === 'community') {
      const cid = Number(url.searchParams.get('id'));
      list = list.filter(post => post.communityId === cid);
    } else if (mode === 'list') {
      const listObj = db.lists.find(l => l.id === Number(url.searchParams.get('id')));
      if (!listObj) return sendJson(res, 404, { error: '列表不存在' });
      if (listObj.private && (!me || (listObj.ownerId !== me.id && !listObj.members.includes(me.id)))) {
        return sendJson(res, 403, { error: '私密列表' });
      }
      const ids = new Set(listObj.memberIds);
      list = list.filter(post => ids.has(post.authorId));
    } else if (mode === 'user') {
      list = db.posts.filter(post => post.authorId === Number(url.searchParams.get('id')) && !post.replyTo);
    } else if (mode === 'bookmarks') {
      if (!me) return sendJson(res, 401, { error: '请先登录' });
      list = db.posts.filter(post => post.bookmarks.includes(me.id));
    } else if (me) {
      list = list.map(post => ({ post, score: scorePost(post, me) })).sort((a, b) => b.score - a.score).map(x => x.post);
      return sendJson(res, 200, { posts: list.slice(0, 50).map(post => hydratePost(post, me)) });
    }
    list.sort((a, b) => b.time - a.time);
    return sendJson(res, 200, { posts: list.slice(0, 50).map(post => hydratePost(post, me)) });
  }

  const postAction = p.match(/^\/api\/posts\/(\d+)(?:\/(like|bookmark|repost|vote|replies))?$/);
  if (postAction && req.method === 'GET' && !postAction[2]) {
    const post = postById(postAction[1]);
    if (!post) return sendJson(res, 404, { error: '不存在' });
    post.views += 1;
    save();
    const replies = db.posts.filter(item => item.replyTo === post.id).sort((a, b) => a.time - b.time);
    return sendJson(res, 200, { post: hydratePost(post, me), replies: replies.map(item => hydratePost(item, me)) });
  }
  if (postAction && req.method === 'POST' && postAction[2]) {
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    const post = postById(postAction[1]);
    if (!post) return sendJson(res, 404, { error: '不存在' });
    const act = postAction[2];
    if (act === 'like') {
      const i = post.likes.indexOf(me.id);
      if (i >= 0) post.likes.splice(i, 1); else { post.likes.push(me.id); notify(post.authorId, 'like', me.id, post.id); }
    } else if (act === 'bookmark') {
      const i = post.bookmarks.indexOf(me.id);
      if (i >= 0) post.bookmarks.splice(i, 1); else post.bookmarks.push(me.id);
    } else if (act === 'repost') {
      const i = post.reposts.indexOf(me.id);
      if (i >= 0) post.reposts.splice(i, 1); else { post.reposts.push(me.id); notify(post.authorId, 'repost', me.id, post.id); }
    } else if (act === 'vote') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (!post.poll) throw Object.assign(new Error('没有投票'), { status: 400 });
      if (post.poll.options.some(o => o.votes.includes(me.id))) throw Object.assign(new Error('已投票'), { status: 400 });
      post.poll.options[Number(body.index)].votes.push(me.id);
    }
    save();
    push(post.authorId, { type: 'post-updated', postId: post.id });
    return sendJson(res, 200, { post: hydratePost(post, me) });
  }
  if (postAction && req.method === 'GET' && postAction[2] === 'replies') {
    const replies = db.posts.filter(item => item.replyTo === Number(postAction[1]));
    return sendJson(res, 200, { replies: replies.map(item => hydratePost(item, me)) });
  }

  if (p === '/api/follow' && req.method === 'POST') {
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const target = userById(Number(body.userId));
    if (!target || target.id === me.id) throw Object.assign(new Error('无法关注'), { status: 400 });
    const i = me.following.indexOf(target.id);
    if (i >= 0) me.following.splice(i, 1); else { me.following.push(target.id); notify(target.id, 'follow', me.id); }
    save();
    return sendJson(res, 200, { following: i < 0 });
  }

  if (p === '/api/users' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const users = db.users.filter(u => !q || u.handle.includes(q) || u.name.toLowerCase().includes(q)).slice(0, 20).map(publicUser);
    return sendJson(res, 200, { users });
  }
  const userPath = p.match(/^\/api\/users\/(\d+)$/);
  if (userPath && req.method === 'GET') {
    const u = userById(Number(userPath[1]));
    if (!u) return sendJson(res, 404, { error: '不存在' });
    return sendJson(res, 200, {
      user: publicUser(u),
      followers: db.users.filter(x => x.following.includes(u.id)).length,
      following: me ? me.following.includes(u.id) : false
    });
  }

  if (p === '/api/communities' && req.method === 'GET') {
    return sendJson(res, 200, { communities: db.communities.map(c => ({ ...c, memberCount: c.members.length, joined: me ? c.members.includes(me.id) : false })) });
  }
  if (p === '/api/communities' && req.method === 'POST') {
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const name = String(body.name || '').trim().slice(0, 40);
    if (name.length < 2) throw Object.assign(new Error('社群名太短'), { status: 400 });
    const community = { id: nid(), name, description: String(body.description || '').slice(0, 200), ownerId: me.id, members: [me.id], createdAt: now() };
    db.communities.push(community);
    me.communities.push(community.id);
    save();
    return sendJson(res, 200, { community });
  }
  const communityJoin = p.match(/^\/api\/communities\/(\d+)\/join$/);
  if (communityJoin && req.method === 'POST') {
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    const c = db.communities.find(item => item.id === Number(communityJoin[1]));
    if (!c) return sendJson(res, 404, { error: '不存在' });
    const i = c.members.indexOf(me.id);
    if (i >= 0) { c.members.splice(i, 1); me.communities = me.communities.filter(id => id !== c.id); }
    else { c.members.push(me.id); me.communities.push(c.id); }
    save();
    return sendJson(res, 200, { joined: i < 0 });
  }

  if (p === '/api/lists' && req.method === 'GET') {
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    const lists = db.lists.filter(l => l.ownerId === me.id || (!l.private && l.memberIds.includes(me.id)) || !l.private);
    return sendJson(res, 200, { lists });
  }
  if (p === '/api/lists' && req.method === 'POST') {
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const list = { id: nid(), name: String(body.name || '未命名列表').slice(0, 40), description: String(body.description || '').slice(0, 160), ownerId: me.id, private: !!body.private, memberIds: [], createdAt: now() };
    db.lists.push(list);
    save();
    return sendJson(res, 200, { list });
  }
  const listMember = p.match(/^\/api\/lists\/(\d+)\/members$/);
  if (listMember && req.method === 'POST') {
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    const list = db.lists.find(item => item.id === Number(listMember[1]));
    if (!list || list.ownerId !== me.id) return sendJson(res, 403, { error: '只能改自己的列表' });
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const uid = Number(body.userId);
    const i = list.memberIds.indexOf(uid);
    if (i >= 0) list.memberIds.splice(i, 1); else list.memberIds.push(uid);
    save();
    return sendJson(res, 200, { list });
  }

  if (p === '/api/notifications' && req.method === 'GET') {
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    const notes = db.notifications.filter(n => n.userId === me.id).slice(-40).reverse().map(hydrateNote);
    return sendJson(res, 200, { notifications: notes });
  }
  if (p === '/api/notifications/read' && req.method === 'POST') {
    if (!me) return sendJson(res, 401, { error: '请先登录' });
    db.notifications.forEach(n => { if (n.userId === me.id) n.read = true; });
    save();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/trends' && req.method === 'GET') {
    const counts = {};
    db.posts.forEach(post => {
      (post.content.match(/#[^\s#]+/g) || []).forEach(tag => { counts[tag] = (counts[tag] || 0) + 1 + post.likes.length; });
    });
    const trends = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tag, score]) => ({ tag, score }));
    return sendJson(res, 200, { trends });
  }

  sendJson(res, 404, { error: 'not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (!res.headersSent) sendJson(res, 500, { error: err.message || 'error' });
  });
}).listen(PORT, () => {
  console.log('善鸡通AI listening on ' + PORT);
});
