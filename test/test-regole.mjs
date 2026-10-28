import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, arrayUnion, arrayRemove, writeBatch } from 'firebase/firestore';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PID = 'demo-ricettario';
const env = await initializeTestEnvironment({ projectId: PID, firestore: { rules: fs.readFileSync(path.join(HERE, '..', 'firestore.rules'),'utf8'), host:'127.0.0.1', port:8085 } });
const db = uid => uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();
const A = db('alice'), B = db('bob'), C = db('carlo'), N = db(null);
let ok = 0, ko = 0; const righe = [];
async function t(name, p){ try{ await p; ok++; console.log('OK  ', name); righe.push('OK   ' + name); }catch(e){ ko++; console.log('FAIL', name, '-', e.message); righe.push('FAIL ' + name + ' - ' + String(e.message).slice(0, 120)); } }
const FID = 'fam00000000000000001';

// 1. A crea la famiglia (come il client: famiglia, invito, profilo, stato)
await t('A crea la famiglia', assertSucceeds(setDoc(doc(A,'families',FID), {name:'Casa', code:'CODE1111', members:['alice']})));
await t('A crea l\'invito', assertSucceeds(setDoc(doc(A,'invites','CODE1111'), {fid:FID})));
await t('A scrive il profilo', assertSucceeds(setDoc(doc(A,'users','alice'), {fid:FID})));
await t('A scrive lo stato condiviso', assertSucceeds(setDoc(doc(A,'families',FID,'state','piano'), {data:'x'})));
await t('C non può creare un invito per la famiglia di A', assertFails(setDoc(doc(C,'invites','FALSO123'), {fid:FID})));

// 2. B entra con codice valido
await t('B legge il codice invito', assertSucceeds(getDoc(doc(B,'invites','CODE1111'))));
await t('B NON entra senza join (codice)', assertFails(updateDoc(doc(B,'families',FID), {members: arrayUnion('bob')})));
await t('B entra con codice valido', assertSucceeds(updateDoc(doc(B,'families',FID), {members: arrayUnion('bob'), join:{uid:'bob',code:'CODE1111'}})));
await t('B legge famiglia e stato', assertSucceeds(getDoc(doc(B,'families',FID,'state','piano'))));

// 3. B NON può togliere A, né cancellare la famiglia o i dati condivisi
await t('B NON può togliere A', assertFails(updateDoc(doc(B,'families',FID), {members: arrayRemove('alice')})));
await t('B NON può sostituire la lista membri', assertFails(updateDoc(doc(B,'families',FID), {members:['bob']})));
await t('B NON può cancellare la famiglia', assertFails(deleteDoc(doc(B,'families',FID))));
await t('B NON può cancellare lo stato condiviso', assertFails(deleteDoc(doc(B,'families',FID,'state','piano'))));
await t('B può rinominare la famiglia', assertSucceeds(updateDoc(doc(B,'families',FID), {name:'Casa nostra'})));

// 4. C con fid ma senza invito valido NON entra
await t('C NON entra con codice inventato', assertFails(updateDoc(doc(C,'families',FID), {members: arrayUnion('carlo'), join:{uid:'carlo',code:'ZZZZZZZZ'}})));
await t('C NON entra senza codice', assertFails(updateDoc(doc(C,'families',FID), {members: arrayUnion('carlo')})));
await t('C NON legge la famiglia', assertFails(getDoc(doc(C,'families',FID))));
await t('C NON legge lo stato', assertFails(getDoc(doc(C,'families',FID,'state','piano'))));
await t('C NON entra senza riscrivere join (join già col codice attuale di B)', assertFails(updateDoc(doc(C,'families',FID), {members: arrayUnion('carlo')})));
await t('C NON entra con join a nome di B', assertFails(updateDoc(doc(C,'families',FID), {members: arrayUnion('carlo'), join:{uid:'bob',code:'CODE1111'}})));
// invito di un'altra famiglia (di C) usato per entrare in quella di A
await setDoc(doc(C,'families','famC'), {name:'C', code:'CCODE111', members:['carlo']});
await setDoc(doc(C,'invites','CCODE111'), {fid:'famC'});
await t('C NON entra con l\'invito di un\'altra famiglia', assertFails(updateDoc(doc(C,'families',FID), {members: arrayUnion('carlo'), join:{uid:'carlo',code:'CCODE111'}})));

// 5. B può uscire (solo sé stesso)
await t('B esce dalla famiglia', assertSucceeds(updateDoc(doc(B,'families',FID), {members: arrayRemove('bob')})));
await t('B dopo l\'uscita non legge più', assertFails(getDoc(doc(B,'families',FID))));

// 6. Rinnovo del codice: il vecchio non vale (anche se il vecchio invito non venisse cancellato)
await t('A crea il nuovo invito', assertSucceeds(setDoc(doc(A,'invites','CODE2222'), {fid:FID})));
await t('A cambia il codice della famiglia', assertSucceeds(updateDoc(doc(A,'families',FID), {code:'CODE2222'})));
await t('B (ex membro) NON rientra col vecchio codice', assertFails(updateDoc(doc(B,'families',FID), {members: arrayUnion('bob'), join:{uid:'bob',code:'CODE1111'}})));
await t('A cancella il vecchio invito', assertSucceeds(deleteDoc(doc(A,'invites','CODE1111'))));
await t('vecchio codice non trovato', getDoc(doc(B,'invites','CODE1111')).then(s => { if(s.exists()) throw new Error('esiste ancora'); }));
await t('B rientra col codice nuovo', assertSucceeds(updateDoc(doc(B,'families',FID), {members: arrayUnion('bob'), join:{uid:'bob',code:'CODE2222'}})));
await t('B esce di nuovo', assertSucceeds(updateDoc(doc(B,'families',FID), {members: arrayRemove('bob')})));

// 7. Nessuna lettura senza login
await t('anonimo (senza login) NON legge famiglia', assertFails(getDoc(doc(N,'families',FID))));
await t('anonimo NON legge invito', assertFails(getDoc(doc(N,'invites','CODE2222'))));
await t('anonimo NON legge profilo', assertFails(getDoc(doc(N,'users','alice'))));
await t('anonimo NON legge stato', assertFails(getDoc(doc(N,'families',FID,'state','piano'))));
await t('anonimo NON legge budgets', assertFails(getDoc(doc(N,'budgets','a'.repeat(40)))));
await t('C NON legge il profilo di A', assertFails(getDoc(doc(C,'users','alice'))));

// 8. Ultimo membro: A non può "uscire" lasciando la famiglia vuota, ma può cancellare tutto
await t('A (ultima) NON può svuotare la lista', assertFails(updateDoc(doc(A,'families',FID), {members: arrayRemove('alice')})));
await t('A (ultima) cancella lo stato', assertSucceeds(deleteDoc(doc(A,'families',FID,'state','piano'))));
await t('A (ultima) cancella l\'invito', assertSucceeds(deleteDoc(doc(A,'invites','CODE2222'))));
await t('A (ultima) cancella la famiglia', assertSucceeds(deleteDoc(doc(A,'families',FID))));

// 9. budgets di Formichina
const D40 = 'b'.repeat(40);
await t('budgets: utente loggato crea doc 40 caratteri', assertSucceeds(setDoc(doc(B,'budgets',D40), {data:'cifrato', by:'x', v:1, updatedAt:1})));
await t('budgets: altro utente legge conoscendo l\'id', assertSucceeds(getDoc(doc(C,'budgets',D40))));
await t('budgets: id di lunghezza sbagliata rifiutato', assertFails(setDoc(doc(B,'budgets','corto'), {data:'x'})));
await t('budgets: campo in più rifiutato', assertFails(setDoc(doc(B,'budgets',D40), {data:'x', altro:1})));
await t('budgets: data non stringa rifiutato', assertFails(setDoc(doc(B,'budgets',D40), {data:5})));
await t('budgets: elenco vietato', assertFails((await import('firebase/firestore')).getDocs((await import('firebase/firestore')).collection(B,'budgets'))));
await t('budgets: senza login non scrive', assertFails(setDoc(doc(N,'budgets',D40), {data:'x'})));
await t('budgets: utente loggato cancella', assertSucceeds(deleteDoc(doc(C,'budgets',D40))));

// 10. Il formato REST esatto del client (commit con updateTransforms e join)
await env.withSecurityRulesDisabled(async ctx => {
  const d = ctx.firestore();
  await setDoc(doc(d,'families','famR'), {name:'R', code:'RCODE111', members:['alice']});
  await setDoc(doc(d,'invites','RCODE111'), {fid:'famR'});
});
const tok = u => Buffer.from(JSON.stringify({alg:'none',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:u,user_id:u,iat:0,exp:9999999999,aud:PID,iss:'https://securetoken.google.com/'+PID,auth_time:0,firebase:{sign_in_provider:'password'}})).toString('base64url')+'.';
const nm = p => `projects/${PID}/databases/(default)/documents/${p}`;
async function restCommit(u, writes){
  const r = await fetch(`http://127.0.0.1:8085/v1/projects/${PID}/databases/(default)/documents:commit`, {method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer '+tok(u)}, body: JSON.stringify({writes})});
  if(!r.ok) throw new Error('HTTP '+r.status+' '+(await r.text()).slice(0,150)); return r.json();
}
const joinW = (u, fid, code) => [{update:{name:nm('families/'+fid), fields:{join:{mapValue:{fields:{uid:{stringValue:u},code:{stringValue:code}}}}}}, updateMask:{fieldPaths:['join']}, updateTransforms:[{fieldPath:'members', appendMissingElements:{values:[{stringValue:u}]}}], currentDocument:{exists:true}}];
await t('REST client: join con codice valido', restCommit('bob', joinW('bob','famR','RCODE111')));
await t('REST client: join con codice sbagliato rifiutato', restCommit('carlo', joinW('carlo','famR','XXXXXXXX')).then(()=>{throw new Error('accettato!')}, e=>{ if(!/403/.test(e.message)) throw e; }));
await t('REST client: vecchio join (solo transform) rifiutato', restCommit('carlo', [{transform:{document:nm('families/famR'), fieldTransforms:[{fieldPath:'members', appendMissingElements:{values:[{stringValue:'carlo'}]}}]}}]).then(()=>{throw new Error('accettato!')}, e=>{ if(!/403/.test(e.message)) throw e; }));
await t('REST client: uscita (removeAllFromArray di sé)', restCommit('bob', [{transform:{document:nm('families/famR'), fieldTransforms:[{fieldPath:'members', removeAllFromArray:{values:[{stringValue:'bob'}]}}]}}]));
await t('REST client: rinnovo codice (updateMask code)', restCommit('alice', [{update:{name:nm('invites/RCODE222'), fields:{fid:{stringValue:'famR'}}}, currentDocument:{exists:false}}]).then(()=>restCommit('alice', [{update:{name:nm('families/famR'), fields:{code:{stringValue:'RCODE222'}}}, updateMask:{fieldPaths:['code']}, currentDocument:{exists:true}}])));

console.log(`\nTotale: ${ok} ok, ${ko} falliti`);
if (process.env.GITHUB_ACTIONS) {
  // un'unica annotazione con l'esito caso per caso (leggibile anche senza scaricare i log)
  const enc = t => t.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::${ko ? 'error' : 'notice'} title=Regole Firestore: ${ok} ok, ${ko} falliti::` + enc(righe.join('\n')));
}
await env.cleanup();
process.exit(ko ? 1 : 0);
