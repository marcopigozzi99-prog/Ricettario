/* Il nostro ricettario — collegamento con Claude
   Un piccolo servizio Cloudflare Workers: riceve le ricette da Claude (protocollo MCP) e le tiene
   finché i telefoni le scaricano. Richiede: un KV chiamato RICETTARIO e un segreto chiamato TOKEN.
   Indirizzi:  https://<tuo-worker>.workers.dev/<TOKEN>/mcp    (da incollare in Claude)
               https://<tuo-worker>.workers.dev/<TOKEN>/inbox  (usato dall'app) */

const TTL = 60 * 60 * 24 * 180;           /* le ricette restano 180 giorni */
const MAX_INBOX = 40;
const CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-max-age': '86400'};
const SERVER = {name: 'ricettario', version: '1.0.0'};
const INSTRUCTIONS = 'Collegamento al ricettario di famiglia. Quando l’utente chiede di aggiungere, salvare o mandare una ricetta al ricettario, leggi prima la ricetta da testo, immagini o pagina web e poi usa aggiungi_ricetta. Non inventare dati mancanti.';

const TOOLS = [
  {name: 'aggiungi_ricetta',
   description: 'Invia una ricetta al ricettario di famiglia: comparirà sul telefono dell’utente, che potrà accettarla o scartarla. Usala solo quando l’utente lo chiede. Leggi la ricetta dal testo, dalle immagini o dalla pagina fornita; non inventare nulla: se un dato manca lascialo vuoto. Scrivi in italiano. Titolo breve, senza emoji e senza tutto maiuscolo. Ingredienti: una voce per riga con quantità e unità metriche (g, ml, cucchiai); converti tazze e once in g o ml. Passaggi: brevi, nell’ordine giusto, senza numerazione. Ignora hashtag, menzioni, inviti a seguire.',
   inputSchema: {type: 'object', properties: {
     titolo: {type: 'string', description: 'Nome del piatto'},
     descrizione: {type: 'string', description: 'Una o due frasi, facoltativa'},
     persone: {type: 'integer', description: 'Per quante persone, se indicato'},
     tempo: {type: 'string', description: 'Es. "30 minuti" o "1 ora e 20 minuti"; vuoto se non indicato'},
     ingredienti: {type: 'array', items: {type: 'string'}, description: 'Una voce per ingrediente, con la quantità'},
     passaggi: {type: 'array', items: {type: 'string'}, description: 'I passaggi in ordine'},
     note: {type: 'string', description: 'Consigli o varianti dell’autore, facoltativo'},
     fonte: {type: 'string', description: 'Link o autore della ricetta, se noto'}},
    required: ['titolo', 'ingredienti', 'passaggi']},
   annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false}},
  {name: 'ricette_inviate',
   description: 'Elenca le ricette mandate di recente al ricettario (titolo e data), per evitare doppioni o rispondere a “cosa ho mandato?”.',
   inputSchema: {type: 'object', properties: {}},
   annotations: {readOnlyHint: true, openWorldHint: false}},
  {name: 'annulla_ricetta_inviata',
   description: 'Toglie dall’app una ricetta mandata per errore, se l’utente non l’ha ancora salvata o scartata. Passa il titolo esatto (vedi ricette_inviate).',
   inputSchema: {type: 'object', properties: {titolo: {type: 'string'}}, required: ['titolo']},
   annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: false}}
];

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {status, headers: {'content-type': 'application/json; charset=utf-8', ...CORS, ...extra}});
const text = (s, status = 200) => new Response(s, {status, headers: {'content-type': 'text/plain; charset=utf-8', ...CORS}});

function sameToken(a, b){
  if(typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for(let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const str = (v, max) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const list = (v, maxItems, maxLen) => (Array.isArray(v) ? v : []).map(x => str(String(x == null ? '' : x), maxLen)).filter(Boolean).slice(0, maxItems);

function cleanRecipe(a){
  a = a || {};
  const n = parseInt(a.persone, 10);
  const r = {title: str(a.titolo, 120).replace(/^ricetta\s*:\s*/i, ''), description: str(a.descrizione, 400),
    servings: (n >= 1 && n <= 20) ? n : null, time: str(a.tempo, 60), ingredients: list(a.ingredienti, 60, 200),
    steps: list(a.passaggi, 40, 1200), note: [str(a.note, 1500), a.fonte ? 'Fonte: ' + str(a.fonte, 300) : ''].filter(Boolean).join('\n')};
  if(!r.title) throw new Error('Manca il titolo.');
  if(!r.ingredients.length) throw new Error('Mancano gli ingredienti.');
  if(!r.steps.length) throw new Error('Mancano i passaggi.');
  return r;
}

async function inbox(env){
  let arr = [];
  try { arr = JSON.parse((await env.RICETTARIO.get('inbox')) || '[]'); } catch(e) { arr = []; }
  const limit = Date.now() - TTL * 1000;
  return (Array.isArray(arr) ? arr : []).filter(x => x && x.title && (!x.sent || Date.parse(x.sent) > limit)).slice(-MAX_INBOX);
}
async function saveInbox(env, arr){ await env.RICETTARIO.put('inbox', JSON.stringify(arr.slice(-MAX_INBOX)), {expirationTtl: TTL}); }

async function callTool(env, name, args){
  const ok = t => ({content: [{type: 'text', text: t}]});
  const err = t => ({content: [{type: 'text', text: t}], isError: true});
  try{
    if(name === 'aggiungi_ricetta'){
      const r = cleanRecipe(args);
      const cur = await inbox(env);
      const dup = cur.find(x => x.title.toLowerCase() === r.title.toLowerCase());
      r.id = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7);
      r.sent = new Date().toISOString();
      cur.push(r);
      await saveInbox(env, cur);
      return ok('Ricetta “' + r.title + '” inviata al ricettario (' + r.ingredients.length + ' ingredienti, ' + r.steps.length + ' passaggi). Comparirà nell’app, in Io → Collegamento a Claude, da accettare.' + (dup ? ' Attenzione: ne era già stata inviata una con lo stesso titolo.' : ''));
    }
    if(name === 'ricette_inviate'){
      const cur = await inbox(env);
      if(!cur.length) return ok('Nessuna ricetta inviata di recente.');
      return ok(cur.map(x => '• ' + x.title + ' (' + String(x.sent || '').slice(0, 10) + ')').join('\n'));
    }
    if(name === 'annulla_ricetta_inviata'){
      const t = str(args && args.titolo, 120).toLowerCase();
      const cur = await inbox(env);
      const hit = cur.filter(x => x.title.toLowerCase() === t);
      if(!hit.length) return err('Non trovo una ricetta con quel titolo tra quelle inviate.');
      await saveInbox(env, cur.filter(x => x.title.toLowerCase() !== t));
      return ok('Tolta: ' + hit[0].title + '.');
    }
    return err('Strumento sconosciuto.');
  }catch(e){ return err(e && e.message ? e.message : 'Errore.'); }
}

async function rpc(env, msg){
  const id = msg && msg.id;
  const isNote = !msg || id === undefined || id === null;
  const reply = result => ({jsonrpc: '2.0', id, result});
  const fail = (code, message) => ({jsonrpc: '2.0', id: id === undefined ? null : id, error: {code, message}});
  if(!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Richiesta non valida');
  switch(msg.method){
    case 'initialize': {
      const want = msg.params && msg.params.protocolVersion;
      const ok = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      return reply({protocolVersion: ok.indexOf(want) !== -1 ? want : ok[1], capabilities: {tools: {listChanged: false}}, serverInfo: SERVER, instructions: INSTRUCTIONS});
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({tools: TOOLS});
    case 'tools/call': return reply(await callTool(env, msg.params && msg.params.name, msg.params && msg.params.arguments));
    default:
      if(isNote) return null;                /* notifiche (es. notifications/initialized): nessuna risposta */
      return fail(-32601, 'Metodo non supportato');
  }
}

export default {
  async fetch(request, env){
    if(request.method === 'OPTIONS') return new Response(null, {status: 204, headers: CORS});
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if(!env.TOKEN || !env.RICETTARIO) return text('Servizio non configurato: mancano TOKEN o RICETTARIO.', 500);
    if(parts.length === 0) return text('Il nostro ricettario — collegamento con Claude. Servizio attivo.');
    if(!sameToken(parts[0], env.TOKEN)) return text('Non trovato', 404);
    const route = parts[1] || '';
    if(route === 'inbox' && request.method === 'GET') return json({recipes: await inbox(env)});
    if(route === 'mcp'){
      if(request.method === 'GET' || request.method === 'DELETE') return text('Metodo non consentito', 405);
      if(request.method !== 'POST') return text('Metodo non consentito', 405);
      let body; try { body = await request.json(); } catch(e) { return json({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'JSON non valido'}}, 400); }
      if(Array.isArray(body)){
        const out = (await Promise.all(body.map(m => rpc(env, m)))).filter(Boolean);
        return out.length ? json(out) : new Response(null, {status: 202, headers: CORS});
      }
      const out = await rpc(env, body);
      return out ? json(out) : new Response(null, {status: 202, headers: CORS});
    }
    return text('Non trovato', 404);
  }
};
