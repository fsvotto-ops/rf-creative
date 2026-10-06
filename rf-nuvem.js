/* RF Creative: ponte entre o app e o Supabase.
   Acesso pelo CÓDIGO DA LOJA (sem e-mail e sem senha). O código vai em cada pedido ao banco
   e o próprio banco recusa tudo se ele estiver errado. Cada aparelho guarda o código depois da 1ª vez. */
(function () {
  const cfg = window.RF_SUPABASE;
  const configurado = cfg && cfg.url && cfg.chave && cfg.chave !== 'COLE_AQUI' && window.supabase;
  const CHAVE_LS = 'rf-codigo-loja';

  /* imagens: reduz antes de guardar */
  window.rfImagem = (file, max = 1600, tipo = 'image/jpeg', qual = 0.82) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onerror = () => rej(new Error('leitura'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => rej(new Error('imagem'));
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        const g = c.getContext('2d');
        if (tipo === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
        g.drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL(tipo, qual));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
  const lerArquivo = f => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(f); });
  const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} };

  const downloads = {
    async save({ filename, data }) {
      const tipo = /\.csv$/i.test(filename) ? 'text/csv;charset=utf-8' : /\.json$/i.test(filename) ? 'application/json' : 'text/html;charset=utf-8';
      const b = data instanceof Blob ? data : new Blob([data], { type: tipo });
      const u = URL.createObjectURL(b), a = document.createElement('a');
      a.href = u; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 5000);
      return { status: 'saved' };
    }
  };
  window.rfDownloads = downloads;

  if (!configurado) return; /* modo local: dados só neste navegador */

  const cliente = codigo => window.supabase.createClient(cfg.url, cfg.chave, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-rf-codigo': codigo } }
  });
  const codigo = lsGet(CHAVE_LS);
  const sb = cliente(codigo);
  const erro = e => { const x = new Error(e?.message || 'erro'); x.code = /row-level security|permission/i.test(e?.message || '') ? 'permission-denied' : (e?.code || 'unavailable'); return x; };

  /* ---------- banco de dados com a mesma "cara" que o app já usa ---------- */
  const ouvintes = {}; /* colecao -> Set(fn) */
  const cacheCol = {}; /* colecao -> Map(id -> {dados, em}) */
  const avisar = col => (ouvintes[col] || new Set()).forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  function snapshotCol(col) {
    const docs = [...(cacheCol[col] || new Map()).entries()].map(([id, r]) => ({ id, exists: true, data: () => r.dados }));
    return { docs, size: docs.length, empty: !docs.length };
  }
  async function lerCols(cols) {
    const res = {}; cols.forEach(c => res[c] = new Map());
    let de = 0;
    for (;;) {
      const { data, error } = await sb.from('registros').select('colecao,id,dados,atualizado_em').in('colecao', cols).range(de, de + 999);
      if (error) throw erro(error);
      data.forEach(r => res[r.colecao].set(r.id, { dados: r.dados || {}, em: r.atualizado_em }));
      if (data.length < 1000) break;
      de += 1000;
    }
    return res;
  }
  /* atualiza a cada 20 s e quando a tela volta a ficar visível (o que outra pessoa lançou aparece) */
  let ocupado = false;
  async function sincronizar() {
    const cols = Object.keys(cacheCol); if (!cols.length || ocupado || document.hidden) return;
    ocupado = true;
    try {
      const novo = await lerCols(cols);
      cols.forEach(c => {
        const a = cacheCol[c], b = novo[c];
        let mudou = a.size !== b.size;
        if (!mudou) for (const [id, r] of b) { const x = a.get(id); if (!x || x.em !== r.em) { mudou = true; break; } }
        if (mudou) { cacheCol[c] = b; avisar(c); }
      });
    } catch (e) {} finally { ocupado = false; }
  }
  setInterval(sincronizar, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sincronizar(); });
  window.addEventListener('focus', sincronizar);

  const pendentes = {};
  function carregar(col) {
    if (cacheCol[col]) return Promise.resolve();
    return pendentes[col] = pendentes[col] || lerCols([col]).then(r => { cacheCol[col] = r[col]; });
  }
  function docRef(col, id) {
    return {
      id,
      async get() {
        const { data, error } = await sb.from('registros').select('dados').eq('colecao', col).eq('id', id).maybeSingle();
        if (error) throw erro(error);
        return { id, exists: !!data, data: () => (data ? data.dados : undefined) };
      },
      async set(dados) {
        const em = new Date().toISOString();
        const { error } = await sb.from('registros').upsert({ colecao: col, id, dados, atualizado_em: em });
        if (error) throw erro(error);
        if (cacheCol[col]) { cacheCol[col].set(id, { dados, em }); avisar(col); }
      },
      async delete() {
        const { error } = await sb.from('registros').delete().eq('colecao', col).eq('id', id);
        if (error) throw erro(error);
        if (cacheCol[col]) { cacheCol[col].delete(id); avisar(col); }
      },
      onSnapshot(next, onErr) {
        const fn = () => { const r = cacheCol[col] && cacheCol[col].get(id); next({ id, exists: !!r, data: () => (r ? r.dados : undefined) }); };
        (ouvintes[col] = ouvintes[col] || new Set()).add(fn);
        carregar(col).then(fn).catch(e => onErr && onErr(e));
        return () => ouvintes[col].delete(fn);
      }
    };
  }
  const db = {
    collection(col) {
      return {
        doc: id => docRef(col, id || novoId()),
        async add(dados) { const r = docRef(col, novoId()); await r.set(dados); return r; },
        onSnapshot(next, onErr) {
          const fn = () => next(snapshotCol(col));
          (ouvintes[col] = ouvintes[col] || new Set()).add(fn);
          carregar(col).then(fn).catch(e => onErr && onErr(e));
          return () => ouvintes[col].delete(fn);
        }
      };
    },
    doc(caminho) { const [col, id] = caminho.split('/'); return docRef(col, id); }
  };

  /* ---------- tela do código da loja ---------- */
  const css = '.rf-login{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg,#EFF2F8)}'
    + '.rf-login form{width:100%;max-width:380px;background:var(--surface,#fff);border:1px solid var(--line,#E0E2EA);border-radius:16px;padding:28px 24px;display:flex;flex-direction:column;gap:14px;box-shadow:0 10px 40px -20px rgba(11,42,99,.35)}'
    + '.rf-login img{width:100%;max-width:300px;align-self:center;margin-bottom:6px;border-radius:8px}'
    + '.rf-login h1{font-size:1.15rem;margin:0;text-align:center}'
    + '.rf-login p{margin:0;font-size:.85rem;color:var(--muted,#5D6371);text-align:center;min-height:1.2em}'
    + '.rf-login .err{color:var(--bad,#BF3434);font-weight:600}.rf-login .ok{color:var(--ok,#1E8556);font-weight:600}'
    + '.rf-login #rf-codigo{text-transform:uppercase;letter-spacing:.12em;text-align:center;font-family:var(--f-mono,monospace);font-size:1.1rem}';
  let tela = null;
  function mostrarCodigo(aviso) {
    if (!document.getElementById('rf-login-css')) { const st = document.createElement('style'); st.id = 'rf-login-css'; st.textContent = css; document.head.appendChild(st); }
    tela = document.createElement('div'); tela.className = 'rf-login';
    tela.innerHTML = '<form novalidate><img src="logo-horizontal.svg" alt="RF Creative Personalizados">'
      + '<h1>Código da loja</h1>'
      + '<label class="f">Digite o código<input class="in" id="rf-codigo" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="RF-XXXX-XXXX"></label>'
      + '<button class="btn primary" type="submit" id="rf-entrar">Entrar</button>'
      + '<p id="rf-msg"></p></form>';
    document.body.appendChild(tela);
    const msg = (t, cls) => { const m = tela.querySelector('#rf-msg'); m.textContent = t; m.className = cls || ''; };
    if (aviso) msg(aviso, 'err');
    tela.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const c = tela.querySelector('#rf-codigo').value.trim().toUpperCase();
      if (!c) { msg('Digite o código da loja.', 'err'); return; }
      const b = tela.querySelector('#rf-entrar'); b.disabled = true; msg('Conferindo…');
      const { data, error } = await cliente(c).rpc('codigo_ok');
      b.disabled = false;
      if (error) { msg(/fetch|network/i.test(error.message) ? 'Sem internet. Verifique a conexão e tente de novo.' : 'Não foi possível conferir agora. Tente de novo.', 'err'); return; }
      if (!data) { msg('Código incorreto.', 'err'); return; }
      lsSet(CHAVE_LS, c); location.reload();
    });
    setTimeout(() => tela && tela.querySelector('#rf-codigo').focus(), 50);
  }

  let liberar; const liberado = new Promise(r => { liberar = r; });
  (async () => {
    if (!codigo) { mostrarCodigo(); return; }
    const { data, error } = await sb.rpc('codigo_ok');
    if (error && /fetch|network/i.test(error.message)) { liberar(); return; } /* sem internet: segue com o que tiver */
    if (!data) { lsSet(CHAVE_LS, ''); mostrarCodigo('O código da loja mudou. Digite o novo código.'); return; }
    liberar();
  })();

  /* ---------- anexos guardados no banco (imagens reduzidas; PDF até ~2 MB) ---------- */
  const cacheArq = {};
  const assets = {
    async upload(file) {
      let data, tipo = file.type || '';
      if (/^image\//.test(tipo) && !/svg/.test(tipo)) { data = await window.rfImagem(file, 1600, 'image/jpeg', 0.82); tipo = 'image/jpeg'; }
      else if (/pdf/.test(tipo) || /\.pdf$/i.test(file.name)) {
        if (file.size > 2 * 1024 * 1024) { const e = new Error('grande'); e.code = 'too_large'; throw e; }
        data = await lerArquivo(file); tipo = 'application/pdf';
      } else { const e = new Error('tipo'); e.code = 'unsupported_type'; throw e; }
      const id = 'a' + novoId();
      await docRef('arquivos', id).set({ nome: file.name, tipo, data, criadoEm: new Date().toISOString() });
      cacheArq[id] = data;
      return { id, url: data, sizeBytes: data.length, contentType: tipo };
    },
    async delete(id) { await docRef('arquivos', id).delete(); delete cacheArq[id]; return { deleted: true }; }
  };
  window.rfBlob = async id => {
    if (cacheArq[id]) return cacheArq[id];
    try { const s = await docRef('arquivos', id).get(); return (cacheArq[id] = s.exists ? s.data().data : ''); } catch (e) { return ''; }
  };
  window.rfAuth = { usuario: () => ({ email: 'Acesso pelo código da loja' }), sair: async () => { lsSet(CHAVE_LS, ''); location.reload(); } };
  window.claude = { use: async nome => { await liberado; return nome === 'db' ? db : nome === 'assets' ? assets : nome === 'downloads' ? downloads : null; } };
})();
