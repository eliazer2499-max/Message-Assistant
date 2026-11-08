// 1.0.2: the site tools. Every tool takes the person from ctx.userId (the conversation), never from the AI, so it
// only ever sees and changes that person's own projects and sites.
import path from 'node:path';
import * as S from '../sites.js';
import { picture } from '../siteflow.js';

const T = (description, extra = {}) => ({ type: 'string', description, ...extra });
const BOOL = (description) => ({ type: 'boolean', description });
const MIME = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.md': 'text/markdown' };

export const SITE_TOOLS = [
  { name: 'project_list', site: true, description: 'List this person\'s own website projects (with sizes) and how much of their space is used.', params: {},
    run: async (_, ctx) => ({ projects: S.listProjects(ctx.userId), space: S.usageText(ctx.userId), sites_allowed: S.maxSites() }) },
  { name: 'file_write', site: true, description: 'Create or replace a text file (HTML, CSS, JavaScript, JSON, SVG…) in one of this person\'s projects. The project is created if new. Up to 2 MB per file.',
    params: { project: T('Project name, e.g. bakery'), path: T('File path inside the project, e.g. index.html or css/style.css'), content: T('The whole file') }, required: ['project', 'path', 'content'],
    run: async ({ project, path: rel, content }, ctx) => ({ ...S.writeFile(ctx.userId, project, rel, content), space: S.usageText(ctx.userId) }) },
  { name: 'file_read', site: true, description: 'Read a text file from one of this person\'s projects.',
    params: { project: T('Project name'), path: T('File path') }, required: ['project', 'path'],
    run: async ({ project, path: rel }, ctx) => { const t = S.readFile(ctx.userId, project, rel).toString('utf8'); return { path: rel, text: t.slice(0, 30000), truncated: t.length > 30000 }; } },
  { name: 'file_list', site: true, description: 'List the files in one of this person\'s projects.',
    params: { project: T('Project name'), path: T('Sub-folder (optional)') }, required: ['project'],
    run: async ({ project, path: rel }, ctx) => ({ files: S.listFiles(ctx.userId, project, rel || '.') }) },
  { name: 'file_delete', site: true, description: 'Delete a file or folder in one of this person\'s projects (path "." deletes the whole project). Only when they asked or to clean up your own mistakes.',
    params: { project: T('Project name'), path: T('File or folder path') }, required: ['project', 'path'],
    run: async ({ project, path: rel }, ctx) => ({ ...S.deletePath(ctx.userId, project, rel), space: S.usageText(ctx.userId) }) },
  { name: 'site_screenshot', site: true, description: 'Take a phone-size picture of a project page. You see it, and (send=true, the default) the person gets it right after your answer. Use it after building or changing a site instead of describing or pasting code.',
    params: { project: T('Project name'), page: T('Page inside the project (default index.html)'), folder: T('Folder of the site inside the project (default .)'), send: BOOL('Send the picture to the person (default true)') }, required: ['project'],
    run: async ({ project, page, folder, send }, ctx) => {
      const dir = S.inProject(ctx.userId, project, folder || '.');
      const p = await picture(ctx.userId, dir, { page: page || '' });
      if (p.error) return { error: p.error + ' Tell them in 1–2 lines what you made instead.' };
      if (send !== false) { ctx.pics = (ctx.pics || []).filter(x => x.project !== project); ctx.pics.push({ project, media: p.media }); }
      const out = { ok: true, note: send !== false ? 'The person gets this picture after your answer. Add only 1–2 short lines.' : 'Only you see this picture.' };
      Object.defineProperty(out, '_see', { value: [{ kind: 'image', mime: 'image/png', data: p.buf.toString('base64'), name: 'phone picture of ' + project }], enumerable: false });
      return out;
    } },
  { name: 'publish_site', site: true, description: 'Put a project online as a public website. Call it as soon as they want it online: the person then gets ONE question with a picture and the link, and answers YES themselves (do not ask them first, do not ask for YES yourself, and do not repeat the question).',
    params: { project: T('Project name'), name: T('Site name for the address (letters, numbers, dashes; default = project name)'), folder: T('Folder inside the project with index.html (default .)') }, required: ['project'],
    run: async ({ project, name, folder }, ctx) => {
      const r = S.fileRequest(ctx.userId, { project, site: name || project, folder: folder || '.' });
      ctx.asks = (ctx.asks || []).filter(x => x.site !== r.site); ctx.asks.push({ id: r.id, site: r.site, project: r.project });
      return { asked: true, address: S.siteUrl(r.public_name), note: 'The question goes to the person right after your answer. End with nothing or one short line; do not mention YES or approval.' };
    } },
  { name: 'unpublish_site', site: true, description: 'Take one of this person\'s own published sites offline (their project files stay).',
    params: { name: T('Site name (from sites_list)') }, required: ['name'],
    run: async ({ name }, ctx) => { const s = S.unpublish({ userId: ctx.userId, name }, 'user#' + ctx.userId); return { unpublished: s.name, was: S.siteUrl(s.public_name) }; } },
  { name: 'sites_list', site: true, description: 'This person\'s own published sites (links) and publish requests that are still waiting.', params: {},
    run: async (_, ctx) => ({
      sites: S.listSites(ctx.userId).map(s => ({ name: s.name, url: s.url, size: s.size, updated: new Date(s.updated).toISOString().slice(0, 10) })),
      waiting: [...S.waitingForUser(ctx.userId).map(r => ({ site: r.site, waiting_for: 'their YES' })), ...S.waitingForAdmin().filter(r => r.user_id === ctx.userId).map(r => ({ site: r.site, waiting_for: 'the admin' }))],
      space: S.usageText(ctx.userId), max_sites: S.maxSites(),
    }) },
  { name: 'send_file', site: true, description: 'Send the person one file from their project (for example index.html) — only when they ask for the code or the file.',
    params: { project: T('Project name'), path: T('File path') }, required: ['project', 'path'],
    run: async ({ project, path: rel }, ctx) => {
      const buf = S.readFile(ctx.userId, project, rel);
      const name = path.basename(String(rel));
      const media = S.saveMedia(buf, { userId: ctx.userId, ext: path.extname(name).slice(1) || 'txt', name });
      ctx.files = [...(ctx.files || []), { media, type: MIME[path.extname(name).toLowerCase()] || 'application/octet-stream' }];
      return { ok: true, note: 'The file goes to them right after your answer (or its private download link if a file cannot be attached). Do not paste its content.' };
    } },
];
