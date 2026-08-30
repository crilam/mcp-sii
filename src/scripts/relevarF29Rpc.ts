import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { perfil, NombrePerfil } from '../perfilesVerificacion';

// Captura las requests GWT-RPC que hace la Consulta Integral F29 al abrir un
// período. GWT no publica URLs ni métodos en el bundle: habla por un protocolo
// serializado propio, así que lo único que se puede leer es lo que el navegador
// manda de verdad. Se inyecta un interceptor de XMLHttpRequest y fetch ANTES de
// disparar el click, y el click se dispara con eventos de mouse reales sobre el
// sprite del período (el `click()` del CLI no le llegaba al handler de GWT).
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-f29-rpc';
const NOMBRE = (process.env.RELEVO_PERFIL ?? 'mercado') as NombrePerfil;
const INTEGRAL = 'https://www4.sii.cl/sifmConsultaInternet/index.html?dest=cifxx&form=29';

const INTERCEPTOR = `
(function(){
  if (window.__rpc) return 'ya';
  window.__rpc = [];
  var open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send, setH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(m, u){ this.__m = m; this.__u = u; this.__h = {}; return open.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function(k, v){ this.__h[k] = v; return setH.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(b){
    var self = this, rec = { via: 'xhr', method: this.__m, url: this.__u, headers: this.__h, body: b == null ? null : String(b).slice(0, 4000), status: null, response: null };
    window.__rpc.push(rec);
    this.addEventListener('loadend', function(){ rec.status = self.status; try { rec.response = String(self.responseText).slice(0, 6000); } catch(e) { rec.response = 'binario'; } });
    return send.apply(this, arguments);
  };
  var f = window.fetch;
  window.fetch = function(u, o){ var rec = { via: 'fetch', method: (o && o.method) || 'GET', url: String(u), headers: (o && o.headers) || {}, body: o && o.body ? String(o.body).slice(0, 4000) : null, status: null, response: null };
    window.__rpc.push(rec);
    return f.apply(this, arguments).then(function(r){ rec.status = r.status; r.clone().text().then(function(t){ rec.response = t.slice(0, 6000); }); return r; }); };
  // Las aperturas de ventana también: el PDF compacto puede salir por ahí.
  window.__open = []; var wo = window.open; window.open = function(u){ window.__open.push(String(u)); return wo ? wo.apply(this, arguments) : null; };
  window.__forms = []; var fs0 = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function(){ window.__forms.push({ action: this.action, method: this.method, target: this.target, campos: Array.from(this.elements).map(function(e){ return e.name + '=' + String(e.value).slice(0, 80); }) }); return fs0.apply(this, arguments); };
  document.addEventListener('submit', function(ev){ var f = ev.target; window.__forms.push({ action: f.action, method: f.method, target: f.target, campos: Array.from(f.elements).map(function(e){ return e.name + '=' + String(e.value).slice(0, 80); }) }); }, true);
  return 'ok';
})()`;

// Click con eventos reales sobre el n-ésimo sprite de período.
const CLICK_SPRITE = (n: number) => `
(function(){
  var imgs = Array.from(document.querySelectorAll('td img'));
  var img = imgs[${n}]; if (!img) return 'sin imagen ' + ${n} + ' de ' + imgs.length;
  var objetivos = [img, img.closest('table'), img.closest('td')];
  var hecho = [];
  objetivos.forEach(function(el){ if (!el) return; ['mouseover','mousedown','mouseup','click'].forEach(function(t){ el.dispatchEvent(new MouseEvent(t, {bubbles:true, cancelable:true, view:window, button:0})); }); hecho.push(el.tagName); });
  return 'eventos a ' + hecho.join(',');
})()`;

async function main() {
  const p = perfil(NOMBRE);
  fs.mkdirSync(SALIDA, { recursive: true });
  const credenciales = new ProveedorCredencialesRuntime();
  if (p.credencial.tipo === 'certificado') {
    credenciales.guardarCertificado(p.rut, p.credencial.certificadoBase64, p.credencial.certificadoPassword, process.env.SII_CERT_CLAVE_SII);
  } else {
    credenciales.guardar(p.rut, p.credencial.clave);
  }
  const registro = crearRegistroSesionesSii(credenciales);

  await registro.ejecutar(p.rut, async sesion => {
    await sesion.authenticateOnly();
    const browser = sesion.obtenerBrowser();
    const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));
    const volcar = (nombre: string) => {
      const crudo = browser.eval('JSON.stringify(window.__rpc || [])');
      let lista: Record<string, unknown>[] = [];
      try { let v: unknown = JSON.parse(crudo); if (typeof v === 'string') v = JSON.parse(v); lista = v as Record<string, unknown>[]; } catch { /* nada */ }
      fs.writeFileSync(path.join(SALIDA, `${nombre}.json`), JSON.stringify(lista, null, 2));
      console.log(`   ${nombre}: ${lista.length} request(s) capturadas`);
      for (const r of lista) {
        console.log(`     ${r.method} ${String(r.url).slice(0, 100)} -> ${r.status}`);
        const h = r.headers as Record<string, string> | undefined;
        if (h && Object.keys(h).length) console.log(`       headers: ${JSON.stringify(h).slice(0, 300)}`);
        if (r.body) console.log(`       body: ${String(r.body).slice(0, 400)}`);
        if (r.response) console.log(`       resp: ${String(r.response).replace(/\s+/g, ' ').slice(0, 400)}`);
      }
      const abiertas = browser.eval('JSON.stringify(window.__open || [])');
      if (abiertas && abiertas !== '[]' && abiertas !== '"[]"') console.log(`   window.open: ${abiertas}`);
      return lista;
    };

    console.log(`Perfil ${NOMBRE} (${p.rut})\n1. Abrir la Consulta Integral`);
    browser.open(INTEGRAL);
    browser.waitForAny(['CONSULTA INTEGRAL', 'Formulario'], 40_000);
    console.log(`   interceptor: ${browser.eval(INTERCEPTOR)}`);

    console.log('\n2. Desplegar F29 (+) con el click del CLI, que ya funcionaba');
    const snap = browser.snapshot();
    const ref = (() => { for (const l of snap.split('\n')) { if (/link "F29 \(\+\)"/.test(l)) { const m = /\[ref=(e\d+)\]/.exec(l); if (m) return m[1]; } } return undefined; })();
    if (ref) browser.click(ref);
    await dormir(4000);
    volcar('rpc-desplegar');

    console.log('\n3. Click con eventos reales sobre el primer sprite (Enero, año más reciente)');
    browser.eval('window.__rpc = []');
    console.log(`   ${browser.eval(CLICK_SPRITE(0))}`);
    await dormir(6000);
    const capturas = volcar('rpc-click-sprite');
    const despues = browser.snapshot();
    fs.writeFileSync(path.join(SALIDA, 'snapshot-despues.txt'), despues);
    console.log(`   url ahora: ${browser.getUrl()}`);
    const nuevas = despues.split('\n').filter(l => !snap.includes(l.trim()) && /StaticText|link|button|heading|cell "/.test(l)).slice(0, 40);
    console.log(`   líneas nuevas en el snapshot (${nuevas.length}):`);
    for (const l of nuevas) console.log(`     ${l.trim().slice(0, 120)}`);

    // 5. El Formulario Compacto: en la pantalla de estado hay un control con esa
    //    opción (getOpcionesEstado devolvió "compacto"). Se busca por texto y se
    //    hace click con eventos reales, capturando RPC, window.open y la URL.
    console.log('\n5. Formulario Compacto');
    const controles = browser.eval(`JSON.stringify(Array.from(document.querySelectorAll('a,button,input,select,option,td,div,span')).filter(e => /compacto/i.test(e.textContent || e.value || '')).slice(0, 12).map(e => ({tag: e.tagName, txt: (e.textContent || e.value || '').trim().slice(0, 60), cls: e.className, id: e.id})))`);
    console.log(`   controles con "compacto": ${controles.slice(0, 900)}`);
    for (const l of despues.split('\n').filter(l => /ompacto|combobox|option|button|listbox/i.test(l)).slice(0, 20)) console.log(`     ${l.trim().slice(0, 120)}`);
    browser.eval('window.__rpc = []; window.__open = []; window.__forms = [];');
    const refBoton = (() => { for (const l of despues.split('\n')) { if (/button "Formulario Compacto"/.test(l)) { const m = /\[ref=(e\d+)\]/.exec(l); if (m) return m[1]; } } return undefined; })();
    console.log(`   botón Formulario Compacto -> ${refBoton}`);
    if (refBoton) browser.click(refBoton);
    await dormir(7000);
    volcar('rpc-compacto');
    console.log(`   forms: ${browser.eval('JSON.stringify(window.__forms || [])').slice(0, 1200)}`);
    console.log(`   url ahora: ${browser.getUrl()}`);
    const snapC = browser.snapshot();
    fs.writeFileSync(path.join(SALIDA, 'snapshot-compacto.txt'), snapC);
    for (const l of snapC.split('\n').filter(l => !despues.includes(l.trim()) && /StaticText|link|button|heading|cell "|iframe|embed|object/.test(l)).slice(0, 30)) console.log(`     ${l.trim().slice(0, 120)}`);
    // Un PDF embebido o un iframe con el compacto:
    console.log(`   iframes/embeds: ${browser.eval("JSON.stringify(Array.from(document.querySelectorAll('iframe,embed,object')).map(e => e.src || e.data || '').slice(0, 10))")}`);

    if (capturas.length === 0) {
      console.log('\n4. Sin RPC tras el sprite: probar el click del CLI sobre el ref de la imagen');
      const refImg = (() => { for (const l of despues.split('\n')) { if (/- image \[ref=e\d+\] clickable/.test(l)) { const m = /\[ref=(e\d+)\]/.exec(l); if (m) return m[1]; } } return undefined; })();
      if (refImg) { browser.click(refImg); await dormir(6000); volcar('rpc-click-cli'); }
    }
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
