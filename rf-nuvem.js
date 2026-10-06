/* RF Creative: ponte entre o app e o Supabase (login, banco de dados em tempo real, anexos e downloads).
   Todos os registros ficam na tabela "registros" (colecao, id, dados). */
(function () {
  const cfg = window.RF_SUPABASE;
  const configurado = cfg && cfg.url && cfg.chave && cfg.chave !== 'COLE_AQUI' && window.supabase;

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

  const sb = window.supabase.createClient(cfg.url, cfg.chave, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  const erro = e => { const x = new Error(e?.message || 'erro'); x.code = /row-level security|permission/i.test(e?.message || '') ? 'permission-denied' : (e?.code || 'unavailable'); return x; };

  /* ---------- banco de dados com a mesma "cara" que o app já usa ---------- */
  const ouvintes = {}; /* colecao -> Set(fn) */
  const cacheCol = {}; /* colecao -> Map(id -> dados) */
  let canal = null;
  function ligarTempoReal() {
    if (canal) return;
    canal = sb.channel('registros-rf')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'registros' }, msg => {
        const linha = msg.new && msg.new.colecao ? msg.new : msg.old;
        if (!linha || !linha.colecao) return;
        const col = linha.colecao, mapa = cacheCol[col];
        if (!mapa) return;
        if (msg.eventType === 'DELETE') mapa.delete(linha.id); else mapa.set(linha.id, msg.new.dados || {});
        avisar(col);
      })
      .subscribe();
  }
  function snapshotCol(col) {
    const docs = [...(cacheCol[col] || new Map()).entries()].map(([id, dados]) => ({ id, exists: true, data: () => dados }));
    return { docs, size: docs.length, empty: !docs.length };
  }
  function avisar(col) { (ouvintes[col] || new Set()).forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }
  async function carregarCol(col) {
    const mapa = new Map(); let de = 0;
    for (;;) {
      const { data, error } = await sb.from('registros').select('id,dados').eq('colecao', col).range(de, de + 999);
      if (error) throw erro(error);
      data.forEach(r => mapa.set(r.id, r.dados || {}));
      if (data.length < 1000) break;
      de += 1000;
    }
    cacheCol[col] = mapa;
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
        const { error } = await sb.from('registros').upsert({ colecao: col, id, dados, atualizado_em: new Date().toISOString() });
        if (error) throw erro(error);
        if (cacheCol[col]) { cacheCol[col].set(id, dados); avisar(col); }
      },
      async delete() {
        const { error } = await sb.from('registros').delete().eq('colecao', col).eq('id', id);
        if (error) throw erro(error);
        if (cacheCol[col]) { cacheCol[col].delete(id); avisar(col); }
      },
      onSnapshot(next, onErr) {
        const fn = () => { const m = cacheCol[col]; const d = m && m.get(id); next({ id, exists: !!d, data: () => d }); };
        (ouvintes[col] = ouvintes[col] || new Set()).add(fn);
        ligarTempoReal();
        (cacheCol[col] ? Promise.resolve() : carregarCol(col)).then(fn).catch(e => onErr && onErr(e));
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
          ligarTempoReal();
          (cacheCol[col] ? Promise.resolve() : carregarCol(col)).then(fn).catch(e => onErr && onErr(e));
          return () => ouvintes[col].delete(fn);
        }
      };
    },
    doc(caminho) { const [col, id] = caminho.split('/'); return docRef(col, id); }
  };

  /* ---------- tela de login ---------- */
  const css = '.rf-login{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg,#EFF2F8)}'
    + '.rf-login form{width:100%;max-width:380px;background:var(--surface,#fff);border:1px solid var(--line,#E0E2EA);border-radius:16px;padding:28px 24px;display:flex;flex-direction:column;gap:14px;box-shadow:0 10px 40px -20px rgba(11,42,99,.35)}'
    + '.rf-login img{width:100%;max-width:300px;align-self:center;margin-bottom:6px;border-radius:8px}'
    + '.rf-login h1{font-size:1.15rem;margin:0;text-align:center}'
    + '.rf-login p{margin:0;font-size:.85rem;color:var(--muted,#5D6371);text-align:center;min-height:1.2em}'
    + '.rf-login .err{color:var(--bad,#BF3434);font-weight:600}.rf-login .ok{color:var(--ok,#1E8556);font-weight:600}'
    + '.rf-login button.link{background:none;border:0;color:var(--accent,#1D5FD1);font-weight:600;cursor:pointer;padding:4px}';
  let tela = null;
  function abrirTela(html) {
    if (!document.getElementById('rf-login-css')) { const st = document.createElement('style'); st.id = 'rf-login-css'; st.textContent = css; document.head.appendChild(st); }
    if (tela) tela.remove();
    tela = document.createElement('div'); tela.className = 'rf-login';
    tela.innerHTML = '<form novalidate><img src="logo-horizontal.svg" alt="RF Creative Personalizados">' + html + '<p id="rf-msg"></p></form>';
    document.body.appendChild(tela);
    return (t, cls) => { const m = tela.querySelector('#rf-msg'); m.textContent = t; m.className = cls || ''; };
  }
  function mostrarLogin() {
    const msg = abrirTela('<h1>Entrar no sistema</h1>'
      + '<label class="f">E-mail<input class="in" id="rf-email" type="email" autocomplete="username" required></label>'
      + '<label class="f">Senha<input class="in" id="rf-senha" type="password" autocomplete="current-password" required></label>'
      + '<button class="btn primary" type="submit" id="rf-entrar">Entrar</button>'
      + '<button class="link" type="button" id="rf-esqueci">Esqueci minha senha</button>');
    tela.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const email = tela.querySelector('#rf-email').value.trim(), senha = tela.querySelector('#rf-senha').value;
      if (!email || !senha) { msg('Informe e-mail e senha.', 'err'); return; }
      const b = tela.querySelector('#rf-entrar'); b.disabled = true; msg('Entrando…');
      const { error } = await sb.auth.signInWithPassword({ email, password: senha });
      if (error) {
        b.disabled = false;
        msg(/fetch|network/i.test(error.message) ? 'Sem internet. Verifique a conexão e tente de novo.'
          : /confirm/i.test(error.message) ? 'Confirme seu e-mail pelo link que enviamos antes de entrar.'
          : 'E-mail ou senha incorretos.', 'err');
      }
    });
    tela.querySelector('#rf-esqueci').addEventListener('click', async () => {
      const email = tela.querySelector('#rf-email').value.trim();
      if (!email) { msg('Digite seu e-mail acima e clique de novo em "Esqueci minha senha".', 'err'); return; }
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      msg(error ? 'Não foi possível enviar agora. Tente de novo em instantes.' : 'Se este e-mail tiver acesso, enviamos um link para criar uma nova senha.', error ? 'err' : 'ok');
    });
    setTimeout(() => tela && tela.querySelector('#rf-email').focus(), 50);
  }
  function mostrarNovaSenha() {
    const msg = abrirTela('<h1>' + (convite ? 'Bem-vinda! Crie sua senha' : 'Criar nova senha') + '</h1>'
      + '<label class="f">Nova senha<input class="in" id="rf-nova" type="password" autocomplete="new-password" minlength="8" required></label>'
      + '<label class="f">Repita a nova senha<input class="in" id="rf-nova2" type="password" autocomplete="new-password" required></label>'
      + '<button class="btn primary" type="submit">Salvar nova senha</button>');
    tela.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const a = tela.querySelector('#rf-nova').value, b = tela.querySelector('#rf-nova2').value;
      if (a.length < 8) { msg('Use pelo menos 8 caracteres.', 'err'); return; }
      if (a !== b) { msg('As duas senhas não são iguais.', 'err'); return; }
      const { error } = await sb.auth.updateUser({ password: a });
      if (error) { msg('Não foi possível salvar. Peça um novo link e tente de novo.', 'err'); return; }
      msg('Senha alterada!', 'ok'); setTimeout(() => location.replace(location.pathname), 900);
    });
  }
  function esconderLogin() { if (tela) { tela.remove(); tela = null; } }

  let liberar; const logado = new Promise(r => { liberar = r; });
  let usuario = null, recuperando = /type=(recovery|invite)/.test(location.hash);
  const convite = /type=invite/.test(location.hash);
  sb.auth.onAuthStateChange((evento, sessao) => {
    if (evento === 'PASSWORD_RECOVERY') { recuperando = true; mostrarNovaSenha(); return; }
    if (recuperando) return;
    if (sessao && sessao.user) { usuario = sessao.user; esconderLogin(); liberar(usuario); }
    else if (evento === 'SIGNED_OUT') location.reload();
  });
  sb.auth.getSession().then(({ data }) => {
    if (recuperando) { if (data.session) mostrarNovaSenha(); else setTimeout(() => { if (!tela) mostrarNovaSenha(); }, 1500); return; }
    if (data.session) { usuario = data.session.user; liberar(usuario); } else mostrarLogin();
  });

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
  window.rfAuth = { usuario: () => usuario, sair: () => sb.auth.signOut() };
  window.claude = { use: async nome => { await logado; return nome === 'db' ? db : nome === 'assets' ? assets : nome === 'downloads' ? downloads : null; } };
})();
