/* estalecas — simulador de apostas com moeda fictícia.
 * Jogos, placares e resultados reais vêm da API pública da ESPN (sem chave).
 * Carteira e apostas ficam salvas no navegador (localStorage).
 */
'use strict';
(() => {
  const API = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
  const STORE_KEY = 'estalecas:v1';
  const START_BALANCE = 1000;
  const DAILY_BONUS = 100;
  const MARGIN = 1.06;           // margem da "casa" embutida nas cotações do modelo
  const MAX_ODD_MULTI = 1000;    // teto da cotação combinada

  const LEAGUES = [
    { slug: 'bra.1', name: 'Brasileirão Série A', flag: '🇧🇷' },
    { slug: 'bra.2', name: 'Brasileirão Série B', flag: '🇧🇷' },
    { slug: 'bra.copa_do_brazil', name: 'Copa do Brasil', flag: '🇧🇷' },
    { slug: 'conmebol.libertadores', name: 'Libertadores', flag: '🌎' },
    { slug: 'conmebol.sudamericana', name: 'Sul-Americana', flag: '🌎' },
    { slug: 'uefa.champions', name: 'Champions League', flag: '🇪🇺' },
    { slug: 'uefa.europa', name: 'Europa League', flag: '🇪🇺' },
    { slug: 'eng.1', name: 'Premier League', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
    { slug: 'esp.1', name: 'La Liga', flag: '🇪🇸' },
    { slug: 'ita.1', name: 'Serie A Itália', flag: '🇮🇹' },
    { slug: 'ger.1', name: 'Bundesliga', flag: '🇩🇪' },
    { slug: 'fra.1', name: 'Ligue 1', flag: '🇫🇷' },
    { slug: 'por.1', name: 'Liga Portugal', flag: '🇵🇹' },
    { slug: 'usa.1', name: 'MLS', flag: '🇺🇸' },
    { slug: 'arg.1', name: 'Liga Argentina', flag: '🇦🇷' },
  ];
  const LEAGUE_ORDER = Object.fromEntries(LEAGUES.map((l, i) => [l.slug, i]));

  const VOID_STATUS = new Set(['STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_ABANDONED', 'STATUS_SUSPENDED', 'STATUS_DELAYED']);
  const MARKET_LABEL = { '1x2': 'Resultado final', ou25: 'Total de gols 2,5', btts: 'Ambas marcam' };

  /* ---------------- utilidades ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round2 = (n) => Math.round(n * 100) / 100;
  const money = (n) => (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const oddFmt = (n) => Number(n).toFixed(2);
  const parseStake = (v) => { const n = Number(String(v).trim().replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? round2(n) : NaN; };
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const dayKey = (d) => ymd(startOfDay(d));
  const hhmm = (d) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const shortDate = (d) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function hash01(str) { // hash determinístico -> 0..1
    let h = 2166136261;
    for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967295;
  }

  /* ---------------- carteira ---------------- */
  function loadWallet() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && typeof s.balance === 'number' && Array.isArray(s.bets)) return s;
    } catch (e) { /* storage indisponível */ }
    return { balance: START_BALANCE, bets: [], lastBonus: null, createdAt: Date.now() };
  }
  let wallet = loadWallet();
  function saveWallet() { try { localStorage.setItem(STORE_KEY, JSON.stringify(wallet)); } catch (e) { /* ignore */ } }

  /* ---------------- estado ---------------- */
  const state = {
    day: startOfDay(new Date()),
    filter: 'all',
    league: 'all',
    cache: {},            // dayKey -> { list, error, at }
    byId: new Map(),      // eventId -> evento normalizado (último visto)
    loadingKey: null,
    expanded: new Set(),
    slip: [],
    slipMode: 'single',
    multiStake: 10,
    defaultStake: 10,
    tab: 'slip',
    betsView: 'open',
    timer: null,
    reqSeq: 0,
  };

  /* ---------------- dados (ESPN) ---------------- */
  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function american(ml) {
    const n = Number(ml);
    if (!n || !isFinite(n)) return null;
    return round2(n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n));
  }
  function strength(c) {
    const recs = c?.records || [];
    const rec = recs.find((r) => r.type === 'total') || recs[0];
    const m = /^(\d+)-(\d+)-(\d+)$/.exec(rec?.summary || '');
    if (!m) return null;
    const w = +m[1], d = +m[2], l = +m[3], g = w + d + l;
    return g >= 3 ? (3 * w + d) / (3 * g) : null;
  }
  const toOdd = (p) => Math.max(1.05, Math.round(100 / (p * MARGIN)) / 100);

  function computeOdds(ev, comp, home, away) {
    const r1 = hash01(ev.id + 'a') - 0.5, r2 = hash01(ev.id + 'b') - 0.5, r3 = hash01(ev.id + 'c') - 0.5;
    const mk = comp?.odds?.[0];
    let h, d, a, source = 'modelo';
    const mh = american(mk?.homeTeamOdds?.moneyLine), ma = american(mk?.awayTeamOdds?.moneyLine), md = american(mk?.drawOdds?.moneyLine);
    if (mh && ma && md) {
      h = mh; d = md; a = ma; source = 'mercado';
    } else {
      const sh = strength(home), sa = strength(away);
      const diff = sh != null && sa != null ? sh - sa : r1 * 0.3;
      let ph = Math.max(0.07, 0.45 + 0.5 * diff + r2 * 0.04);
      let pa = Math.max(0.07, 0.28 - 0.5 * diff - r2 * 0.04);
      let pd = Math.max(0.15, 0.27 - 0.12 * Math.abs(diff));
      const s = ph + pa + pd; ph /= s; pa /= s; pd /= s;
      h = toOdd(ph); d = toOdd(pd); a = toOdd(pa);
    }
    const pOver = 0.52 + r3 * 0.16;
    const pBtts = 0.50 + r1 * 0.16;
    return {
      '1x2': { home: h, draw: d, away: a },
      ou25: { over: toOdd(pOver), under: toOdd(1 - pOver) },
      btts: { yes: toOdd(pBtts), no: toOdd(1 - pBtts) },
      source,
    };
  }

  function scoreOf(c) {
    if (!c || c.score == null || c.score === '') return null;
    const v = typeof c.score === 'object' ? (c.score.value ?? c.score.displayValue) : c.score;
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  function teamOf(c) {
    const t = c?.team || {};
    return {
      name: t.displayName || t.name || 'A definir',
      short: t.shortDisplayName || t.displayName || t.name || '?',
      logo: t.logo || t.logos?.[0]?.href || '',
      score: scoreOf(c),
      winner: !!c?.winner,
    };
  }

  function normEvent(ev, lg) {
    const comp = ev.competitions?.[0] || {};
    const cs = comp.competitors || [];
    const hc = cs.find((c) => c.homeAway === 'home') || cs[0];
    const ac = cs.find((c) => c.homeAway === 'away') || cs[1];
    const st = comp.status || ev.status || {};
    const t = st.type || {};
    return {
      id: String(ev.id),
      league: lg.slug, leagueName: lg.name, flag: lg.flag,
      date: new Date(ev.date),
      state: t.state || 'pre',
      completed: !!t.completed,
      statusName: t.name || '',
      detail: t.shortDetail || t.detail || '',
      clock: st.displayClock || '',
      home: teamOf(hc), away: teamOf(ac),
      odds: computeOdds(ev, comp, hc, ac),
    };
  }

  async function loadDay(day, silent = false) {
    const key = dayKey(day);
    const seq = ++state.reqSeq;
    if (!silent) { state.loadingKey = key; renderList(); }
    const range = `${ymd(addDays(day, -1))}-${ymd(addDays(day, 1))}`;
    const results = await Promise.allSettled(LEAGUES.map((lg) =>
      getJSON(`${API}/${lg.slug}/scoreboard?dates=${range}&limit=300`)
        .then((j) => (j.events || []).map((ev) => normEvent(ev, lg)))
    ));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const seen = new Set();
    const list = [];
    for (const r of ok) for (const e of r.value) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      state.byId.set(e.id, e);
      if (dayKey(e.date) === key) list.push(e);
    }
    list.sort((a, b) => (LEAGUE_ORDER[a.league] - LEAGUE_ORDER[b.league]) || (a.date - b.date) || a.home.name.localeCompare(b.home.name));

    const prev = state.cache[key];
    // se tudo falhou num refresh silencioso, mantém os dados anteriores
    if (ok.length === 0 && prev && prev.list.length) prev.error = true;
    else state.cache[key] = { list, error: ok.length === 0, at: new Date() };

    if (state.loadingKey === key) state.loadingKey = null;
    settleFromEvents([...state.byId.values()]);
    refreshSlipOdds();
    if (seq === state.reqSeq || key === dayKey(state.day)) renderAll();
    scheduleRefresh();
  }

  function scheduleRefresh() {
    clearTimeout(state.timer);
    const cur = state.cache[dayKey(state.day)];
    const live = cur?.list?.some((e) => e.state === 'in');
    const isToday = dayKey(state.day) === dayKey(new Date());
    const ms = live ? 30000 : isToday ? 120000 : 300000;
    state.timer = setTimeout(() => { if (!document.hidden) loadDay(state.day, true); else scheduleRefresh(); }, ms);
  }

  /* ---------------- regras ---------------- */
  const isVoid = (e) => VOID_STATUS.has(e.statusName);
  const isFinal = (e) => !isVoid(e) && (e.completed || e.state === 'post') && e.home.score != null && e.away.score != null;
  const isBettable = (e) => e.state === 'pre' && !isVoid(e) && e.date.getTime() > Date.now() + 60000;

  function legWins(market, pick, h, a) {
    if (market === '1x2') return pick === (h > a ? 'home' : h < a ? 'away' : 'draw');
    if (market === 'ou25') return pick === 'over' ? h + a > 2.5 : h + a < 2.5;
    if (market === 'btts') { const both = h > 0 && a > 0; return pick === 'yes' ? both : !both; }
    return false;
  }
  function winningKeys(h, a) {
    const s = new Set();
    for (const [m, picks] of [['1x2', ['home', 'draw', 'away']], ['ou25', ['over', 'under']], ['btts', ['yes', 'no']]])
      for (const p of picks) if (legWins(m, p, h, a)) s.add(`${m}:${p}`);
    return s;
  }
  function pickLabel(e, market, pick) {
    if (market === '1x2') return pick === 'home' ? e.home.name : pick === 'away' ? e.away.name : 'Empate';
    if (market === 'ou25') return pick === 'over' ? 'Mais de 2,5 gols' : 'Menos de 2,5 gols';
    if (market === 'btts') return pick === 'yes' ? 'Ambas marcam: Sim' : 'Ambas marcam: Não';
    return pick;
  }

  /* ---------------- liquidação ---------------- */
  function applyResult(eventId, info) {
    const settled = [];
    for (const bet of wallet.bets) {
      if (bet.status !== 'pending') continue;
      let touched = false;
      for (const leg of bet.legs) {
        if (leg.eventId !== eventId || leg.result !== 'pending') continue;
        if (info.void) { leg.result = 'void'; }
        else { leg.result = legWins(leg.market, leg.pick, info.h, info.a) ? 'won' : 'lost'; leg.score = `${info.h} x ${info.a}`; }
        touched = true;
      }
      if (touched && finalizeBet(bet)) settled.push(bet);
    }
    return settled;
  }

  function finalizeBet(bet) {
    if (bet.status !== 'pending') return false;
    if (bet.legs.some((l) => l.result === 'lost')) {
      bet.status = 'lost'; bet.payout = 0; bet.settledAt = Date.now();
      return true;
    }
    if (bet.legs.some((l) => l.result === 'pending')) return false;
    const odd = bet.legs.reduce((m, l) => m * (l.result === 'void' ? 1 : l.odd), 1);
    bet.payout = round2(bet.stake * odd);
    bet.status = bet.legs.every((l) => l.result === 'void') ? 'void' : 'won';
    bet.settledAt = Date.now();
    wallet.balance = round2(wallet.balance + bet.payout);
    return true;
  }

  function settleFromEvents(events) {
    const pendingIds = new Set();
    for (const b of wallet.bets) if (b.status === 'pending') for (const l of b.legs) if (l.result === 'pending') pendingIds.add(l.eventId);
    if (!pendingIds.size) return;
    const settled = [];
    for (const e of events) {
      if (!pendingIds.has(e.id)) continue;
      if (isVoid(e)) settled.push(...applyResult(e.id, { void: true }));
      else if (isFinal(e)) settled.push(...applyResult(e.id, { h: e.home.score, a: e.away.score }));
    }
    announce(settled);
  }

  // Apostas em jogos de outros dias: consulta o resumo do jogo diretamente
  async function syncPending() {
    const pend = new Map();
    for (const b of wallet.bets) if (b.status === 'pending')
      for (const l of b.legs) if (l.result === 'pending' && new Date(l.kickoff).getTime() < Date.now()) pend.set(l.eventId, l.league);
    const settled = [];
    for (const [id, league] of [...pend].slice(0, 25)) {
      try {
        const j = await getJSON(`${API}/${league}/summary?event=${id}`);
        const comp = j?.header?.competitions?.[0];
        if (!comp) continue;
        const t = comp.status?.type || {};
        const cs = comp.competitors || [];
        const h = scoreOf(cs.find((c) => c.homeAway === 'home')), a = scoreOf(cs.find((c) => c.homeAway === 'away'));
        if (VOID_STATUS.has(t.name)) settled.push(...applyResult(id, { void: true }));
        else if ((t.completed || t.state === 'post') && h != null && a != null) settled.push(...applyResult(id, { h, a }));
      } catch (e) { /* tenta de novo depois */ }
    }
    announce(settled);
    if (settled.length) renderAll();
  }

  function announce(settled) {
    if (!settled.length) return;
    saveWallet();
    const won = settled.filter((b) => b.status === 'won');
    const gain = won.reduce((s, b) => s + b.payout, 0);
    if (won.length) toast(`🎉 ${won.length > 1 ? won.length + ' apostas ganhas' : 'Aposta ganha'}! +${money(gain)} estalecas`, 'good');
    else if (settled.some((b) => b.status === 'void')) toast('Jogo adiado/cancelado — aposta devolvida.', '');
    else toast(`${settled.length > 1 ? settled.length + ' apostas perdidas' : 'Aposta perdida'}. Fica pra próxima!`, 'bad');
    bumpBalance();
  }

  /* ---------------- cupom ---------------- */
  function toggleSelection(e, market, pick) {
    const i = state.slip.findIndex((s) => s.eventId === e.id);
    if (i >= 0 && state.slip[i].market === market && state.slip[i].pick === pick) {
      state.slip.splice(i, 1);
    } else {
      const sel = {
        eventId: e.id, league: e.league, match: `${e.home.name} x ${e.away.name}`, kickoff: e.date.toISOString(),
        market, pick, label: pickLabel(e, market, pick), odd: e.odds[market][pick],
        stake: i >= 0 ? state.slip[i].stake : state.defaultStake,
      };
      if (i >= 0) state.slip[i] = sel; else state.slip.push(sel);
      popFab();
    }
    if (state.slip.length < 2) state.slipMode = 'single';
    else if (state.slip.length === 2 && i < 0) state.slipMode = 'multi';
  }

  function refreshSlipOdds() {
    for (const s of state.slip) {
      const e = state.byId.get(s.eventId);
      if (e) { s.odd = e.odds[s.market][s.pick]; s.stale = !isBettable(e); }
    }
  }

  function slipCalc() {
    const s = state.slip;
    const mode = s.length > 1 ? state.slipMode : 'single';
    if (mode === 'multi') {
      const odd = Math.min(MAX_ODD_MULTI, round2(s.reduce((m, x) => m * x.odd, 1)));
      const stake = parseStake(state.multiStake);
      return { mode, odd, total: isNaN(stake) ? 0 : stake, ret: isNaN(stake) ? 0 : round2(stake * odd), stakes: [stake] };
    }
    const stakes = s.map((x) => parseStake(x.stake));
    const total = round2(stakes.reduce((m, v) => m + (isNaN(v) ? 0 : v), 0));
    const ret = round2(s.reduce((m, x, i) => m + (isNaN(stakes[i]) ? 0 : stakes[i] * x.odd), 0));
    return { mode, total, ret, stakes };
  }

  function slipProblem(c) {
    if (!state.slip.length) return 'empty';
    if (state.slip.some((s) => s.stale)) return 'Remova os jogos que já começaram.';
    if (c.stakes.some((v) => isNaN(v) || v < 1)) return 'Valor mínimo: 1 estaleca por aposta.';
    if (c.total > wallet.balance + 1e-9) return 'Saldo insuficiente.';
    return '';
  }

  function placeBets() {
    refreshSlipOdds();
    const c = slipCalc();
    const problem = slipProblem(c);
    if (problem) { toast(problem === 'empty' ? 'Cupom vazio.' : problem, 'bad'); renderSlip(); return; }
    const mkLeg = (s) => ({ eventId: s.eventId, league: s.league, match: s.match, kickoff: s.kickoff, market: s.market, pick: s.pick, label: s.label, odd: s.odd, result: 'pending' });
    const newBets = c.mode === 'multi'
      ? [{ id: uid(), placedAt: Date.now(), type: 'Múltipla', stake: c.total, odd: c.odd, legs: state.slip.map(mkLeg), status: 'pending', payout: null }]
      : state.slip.map((s, i) => ({ id: uid(), placedAt: Date.now(), type: 'Simples', stake: c.stakes[i], odd: s.odd, legs: [mkLeg(s)], status: 'pending', payout: null }));
    wallet.balance = round2(wallet.balance - c.total);
    wallet.bets.unshift(...newBets);
    saveWallet();
    state.slip = [];
    state.tab = 'bets'; state.betsView = 'open';
    toast(`✅ ${newBets.length > 1 ? newBets.length + ' apostas feitas' : 'Aposta feita'} · ${money(c.total)} estalecas`, 'good');
    bumpBalance();
    renderAll();
  }

  /* ---------------- render ---------------- */
  function renderAll() {
    renderBalance(); renderDays(); renderFilters(); renderList(); renderSide();
  }

  function renderBalance() {
    $('#balance').textContent = money(wallet.balance);
    const today = dayKey(new Date());
    const b = $('#bonusBtn');
    b.disabled = wallet.lastBonus === today;
    b.textContent = b.disabled ? 'Bônus resgatado ✓' : `+${DAILY_BONUS} bônus diário`;
  }
  function bumpBalance() {
    renderBalance();
    const el = $('.balance'); el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
  }

  function renderDays() {
    const today = startOfDay(new Date());
    let html = '';
    for (let i = -3; i <= 7; i++) {
      const d = addDays(today, i);
      const name = i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : i === -1 ? 'Ontem' : d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
      const active = dayKey(d) === dayKey(state.day) ? ' active' : '';
      html += `<button type="button" class="day${active}" data-day="${ymd(d)}"><b>${esc(name)}</b><small>${shortDate(d)}</small></button>`;
    }
    const el = $('#days');
    el.innerHTML = html;
    el.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function currentList() {
    const c = state.cache[dayKey(state.day)];
    return c ? c.list : [];
  }

  function renderFilters() {
    const list = currentList();
    const counts = { all: list.length, live: 0, pre: 0, post: 0 };
    for (const e of list) counts[e.state === 'in' ? 'live' : e.state === 'pre' ? 'pre' : 'post']++;
    document.querySelectorAll('#statusFilter button').forEach((b) => {
      const f = b.dataset.f;
      b.classList.toggle('active', f === state.filter);
      b.classList.toggle('has', f === 'live' && counts.live > 0);
      b.querySelector('em').textContent = counts[f] ? counts[f] : '';
    });
    const byLeague = new Map();
    for (const e of list) byLeague.set(e.league, (byLeague.get(e.league) || 0) + 1);
    if (state.league !== 'all' && !byLeague.has(state.league)) state.league = 'all';
    const opts = [`<option value="all">Todos os campeonatos (${list.length})</option>`]
      .concat(LEAGUES.filter((l) => byLeague.has(l.slug)).map((l) => `<option value="${l.slug}"${state.league === l.slug ? ' selected' : ''}>${l.flag} ${esc(l.name)} (${byLeague.get(l.slug)})</option>`));
    $('#leagueFilter').innerHTML = opts.join('');
    const cache = state.cache[dayKey(state.day)];
    $('#updated').textContent = cache?.at ? `Atualizado às ${cache.at.toLocaleTimeString('pt-BR')} · fonte: ESPN${cache.error ? ' · falha na última atualização' : ''}` : '';
  }

  function renderList() {
    const el = $('#list');
    const key = dayKey(state.day);
    const cache = state.cache[key];
    if (!cache) {
      el.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div>';
      return;
    }
    if (cache.error && !cache.list.length) {
      el.innerHTML = `<div class="error"><b>Não foi possível carregar os jogos</b>A fonte de resultados (ESPN) não respondeu. Verifique a conexão e tente de novo.<br><button type="button" data-retry>Tentar novamente</button></div>`;
      return;
    }
    let list = cache.list;
    if (state.league !== 'all') list = list.filter((e) => e.league === state.league);
    if (state.filter !== 'all') list = list.filter((e) => (state.filter === 'live' ? e.state === 'in' : state.filter === 'pre' ? e.state === 'pre' : e.state === 'post'));
    if (!list.length) {
      const msg = state.filter === 'live' ? 'Nenhum jogo ao vivo agora.' : cache.list.length ? 'Nenhum jogo neste filtro.' : 'Nenhum jogo dos campeonatos acompanhados neste dia.';
      el.innerHTML = `<div class="empty"><b>${msg}</b>Escolha outro dia ou filtro.</div>`;
      return;
    }
    const groups = new Map();
    for (const e of list) { if (!groups.has(e.league)) groups.set(e.league, []); groups.get(e.league).push(e); }
    let html = '';
    for (const [slug, evs] of groups) {
      const lg = LEAGUES[LEAGUE_ORDER[slug]];
      html += `<section class="league"><h3 class="league-h"><span>${lg.flag}</span>${esc(lg.name)}<span class="count">${evs.length} jogo${evs.length > 1 ? 's' : ''}</span></h3><div class="cards">${evs.map(matchHTML).join('')}</div></section>`;
    }
    el.innerHTML = html;
  }

  function statusInfo(e) {
    const n = e.statusName;
    if (isVoid(e)) return { cls: 'void', text: n === 'STATUS_POSTPONED' ? 'Adiado' : n === 'STATUS_ABANDONED' ? 'Abandonado' : n === 'STATUS_SUSPENDED' ? 'Suspenso' : n === 'STATUS_DELAYED' ? 'Atrasado' : 'Cancelado' };
    if (e.state === 'in') {
      if (n === 'STATUS_HALFTIME') return { cls: 'live', text: 'Intervalo' };
      return { cls: 'live', text: e.clock && e.clock !== "0'" ? e.clock : 'Ao vivo' };
    }
    if (e.state === 'post') {
      const t = n === 'STATUS_FINAL_AET' ? 'Encerrado · prorrogação' : n === 'STATUS_FINAL_PEN' ? 'Encerrado · pênaltis' : 'Encerrado';
      return { cls: 'post', text: t };
    }
    return { cls: 'pre', text: hhmm(e.date) };
  }

  function matchHTML(e) {
    const st = statusInfo(e);
    const bettable = isBettable(e);
    const final = isFinal(e);
    const hits = final ? winningKeys(e.home.score, e.away.score) : new Set();
    const showScore = e.state !== 'pre' && e.home.score != null;
    const sel = state.slip.find((s) => s.eventId === e.id);
    const btn = (market, pick, label) => {
      const k = `${market}:${pick}`;
      const cls = ['odd'];
      if (sel && sel.market === market && sel.pick === pick) cls.push('sel');
      if (hits.has(k)) cls.push('hit');
      const val = bettable || final ? oddFmt(e.odds[market][pick]) : '🔒';
      return `<button type="button" class="${cls.join(' ')}" data-ev="${esc(e.id)}" data-m="${market}" data-p="${pick}"${bettable ? '' : ' disabled'} aria-label="${esc(pickLabel(e, market, pick))} ${val}"><span class="o-lbl">${esc(label)}</span><span class="o-val">${val}</span></button>`;
    };
    const team = (t, other) => {
      const cls = final && t.score < other.score ? ' lose' : '';
      return `<div class="team${cls}"><img src="${esc(t.logo)}" alt="" loading="lazy" width="22" height="22"><span class="t-name" title="${esc(t.name)}">${esc(t.name)}</span><span class="t-score">${showScore ? t.score : ''}</span></div>`;
    };
    const open = state.expanded.has(e.id);
    return `<article class="match${e.state === 'in' ? ' is-live' : ''}">
      <div class="m-meta"><span class="status ${st.cls}">${esc(st.text)}</span>${e.odds.source === 'mercado' ? '<span class="m-src">· cotação de mercado</span>' : ''}
        <button type="button" class="more" data-more="${esc(e.id)}" aria-expanded="${open}">${open ? '− mercados' : '+4 mercados'}</button></div>
      <div class="teams">${team(e.home, e.away)}${team(e.away, e.home)}</div>
      <div class="odds">${btn('1x2', 'home', '1')}${btn('1x2', 'draw', 'X')}${btn('1x2', 'away', '2')}</div>
      ${open ? `<div class="extra">
        <div class="mk"><h4>Total de gols</h4><div class="odds">${btn('ou25', 'over', 'Mais 2,5')}${btn('ou25', 'under', 'Menos 2,5')}</div></div>
        <div class="mk"><h4>Ambas marcam</h4><div class="odds">${btn('btts', 'yes', 'Sim')}${btn('btts', 'no', 'Não')}</div></div>
      </div>` : ''}
    </article>`;
  }

  function renderSide() {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    $('#slipPanel').hidden = state.tab !== 'slip';
    $('#betsPanel').hidden = state.tab !== 'bets';
    const open = wallet.bets.filter((b) => b.status === 'pending').length;
    $('#slipCount').textContent = state.slip.length;
    $('#openCount').textContent = open;
    $('#fabCount').textContent = state.slip.length || open;
    $('#fab span').textContent = state.slip.length ? 'Cupom' : 'Minhas apostas';
    renderSlip(); renderBets();
  }

  function renderSlip() {
    const el = $('#slipPanel');
    const s = state.slip;
    if (!s.length) {
      el.innerHTML = `<div class="slip-empty"><span class="ico">🎟️</span><b>Seu cupom está vazio</b><br>Toque numa cotação para adicionar um palpite. Com 2 ou mais jogos você pode fazer uma múltipla.</div>`;
      return;
    }
    const mode = s.length > 1 ? state.slipMode : 'single';
    let html = '';
    if (s.length > 1) html += `<div class="modes"><button type="button" data-mode="single" class="${mode === 'single' ? 'active' : ''}">Simples (${s.length})</button><button type="button" data-mode="multi" class="${mode === 'multi' ? 'active' : ''}">Múltipla</button></div>`;
    s.forEach((x, i) => {
      html += `<div class="sl-item${x.stale ? ' stale' : ''}">
        <div class="sl-top"><span class="sl-pick">${esc(x.label)}</span><span class="sl-odd">${oddFmt(x.odd)}</span><button type="button" class="x" data-rm="${i}" aria-label="Remover">×</button></div>
        <div class="sl-sub">${esc(MARKET_LABEL[x.market])} · ${esc(x.match)}${x.stale ? ' · <span class="danger">já começou</span>' : ''}</div>
        ${mode === 'single' ? `<div class="stake-row"><label for="st${i}">Valor</label><input id="st${i}" class="stake" data-i="${i}" inputmode="decimal" autocomplete="off" value="${esc(x.stake)}"><span class="ret">Retorno<br><b data-ret="${i}"></b></span></div>` : ''}
      </div>`;
    });
    if (mode === 'multi') {
      html += `<div class="multi-box"><div class="row"><span>Cotação combinada</span><b id="multiOdd" class="pos"></b></div>
        <div class="stake-row"><label for="stm">Valor</label><input id="stm" class="stake" data-multi inputmode="decimal" autocomplete="off" value="${esc(state.multiStake)}"></div></div>`;
    }
    html += `<div class="chips">${[5, 10, 25, 50, 100].map((v) => `<button type="button" data-chip="${v}">${v}</button>`).join('')}<button type="button" data-chip="max">Máx</button></div>
      <div class="summary"><div class="row"><span>Total apostado</span><b id="sumTotal"></b></div><div class="row big"><span>Retorno potencial</span><b id="sumRet"></b></div></div>
      <button type="button" class="place" id="placeBtn">Apostar</button><div class="hint" id="slipHint"></div>
      <button type="button" class="linkish" data-clear>Limpar cupom</button>`;
    el.innerHTML = html;
    updateSlipTotals();
  }

  function updateSlipTotals() {
    const c = slipCalc();
    state.slip.forEach((x, i) => {
      const r = document.querySelector(`[data-ret="${i}"]`);
      if (r) { const v = parseStake(x.stake); r.textContent = isNaN(v) ? '—' : money(v * x.odd); }
    });
    const mo = $('#multiOdd'); if (mo) mo.textContent = oddFmt(c.odd);
    const t = $('#sumTotal'); if (t) t.textContent = money(c.total);
    const r = $('#sumRet'); if (r) r.textContent = money(c.ret);
    const problem = slipProblem(c);
    const btn = $('#placeBtn');
    if (btn) {
      btn.disabled = !!problem;
      btn.textContent = problem ? 'Apostar' : `Apostar ${money(c.total)}`;
    }
    const h = $('#slipHint'); if (h) h.textContent = problem && problem !== 'empty' ? problem : '';
  }

  function legSub(l) {
    const e = state.byId.get(l.eventId);
    let when;
    if (l.result !== 'pending' && l.score) when = `Final: ${esc(l.score)}`;
    else if (l.result === 'void') when = 'Jogo adiado/cancelado';
    else if (e && e.state === 'in') when = `<span class="live">● ${esc(statusInfo(e).text)} · ${e.home.score ?? 0} x ${e.away.score ?? 0}</span>`;
    else { const d = new Date(l.kickoff); when = `${shortDate(d)} ${hhmm(d)}`; }
    return `${esc(MARKET_LABEL[l.market])} · ${esc(l.match)} · ${when}`;
  }

  function renderBets() {
    const el = $('#betsPanel');
    const all = wallet.bets;
    const staked = all.reduce((s, b) => s + (b.status === 'void' ? 0 : b.stake), 0);
    const returned = all.reduce((s, b) => s + (b.status === 'won' ? b.payout : 0), 0);
    const settledStake = all.filter((b) => b.status === 'won' || b.status === 'lost').reduce((s, b) => s + b.stake, 0);
    const profit = round2(returned - settledStake);
    const open = all.filter((b) => b.status === 'pending');
    const done = all.filter((b) => b.status !== 'pending');
    const view = state.betsView === 'open' ? open : done;
    let html = `<div class="stats">
        <div class="stat"><small>Apostado</small><b>${money(staked)}</b></div>
        <div class="stat"><small>Ganhos</small><b>${money(returned)}</b></div>
        <div class="stat"><small>Lucro</small><b class="${profit > 0 ? 'pos' : profit < 0 ? 'neg' : ''}">${profit > 0 ? '+' : ''}${money(profit)}</b></div>
      </div>
      <div class="modes"><button type="button" data-bv="open" class="${state.betsView === 'open' ? 'active' : ''}">Abertas (${open.length})</button><button type="button" data-bv="done" class="${state.betsView === 'done' ? 'active' : ''}">Encerradas (${done.length})</button></div>`;
    if (!view.length) {
      html += `<div class="slip-empty">${state.betsView === 'open' ? 'Nenhuma aposta em aberto.' : 'Nenhuma aposta encerrada ainda.'}</div>`;
    } else {
      const badge = { pending: 'Em aberto', won: 'Ganhou', lost: 'Perdeu', void: 'Devolvida' };
      html += view.slice(0, 100).map((b) => `<div class="bet ${b.status}">
        <div class="bet-h"><span class="badge">${badge[b.status]}</span><span>${esc(b.type)} · ${new Date(b.placedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></div>
        ${b.legs.map((l) => `<div class="leg"><i class="dot ${l.result}"></i><div><b>${esc(l.label)}</b> <span class="odd-inline">@ ${oddFmt(l.odd)}</span><div class="sub">${legSub(l)}</div></div></div>`).join('')}
        <div class="bet-f"><span>Apostado <b>${money(b.stake)}</b> · @ <b>${oddFmt(b.odd)}</b></span><span class="ret">${b.status === 'pending' ? 'Possível' : 'Retorno'} <b>${money(b.status === 'pending' ? b.stake * b.odd : b.payout)}</b></span></div>
      </div>`).join('');
    }
    html += `<button type="button" class="linkish" data-reset>Zerar carteira e histórico</button>`;
    el.innerHTML = html;
  }

  /* ---------------- UI helpers ---------------- */
  let toastTimer;
  function toast(msg, kind = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
  }
  function popFab() { const f = $('#fab'); f.classList.remove('pop'); void f.offsetWidth; f.classList.add('pop'); }
  function openSheet(open) {
    $('#side').classList.toggle('open', open);
    $('#backdrop').classList.toggle('show', open);
  }

  /* ---------------- eventos ---------------- */
  function bind() {
    document.addEventListener('error', (ev) => { if (ev.target.tagName === 'IMG') ev.target.classList.add('noimg'); }, true);

    $('#days').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-day]'); if (!b) return;
      const s = b.dataset.day;
      state.day = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
      state.filter = 'all';
      renderAll();
      const c = state.cache[dayKey(state.day)];
      loadDay(state.day, !!c); // se já tem cache, atualiza em silêncio
    });

    $('#statusFilter').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-f]'); if (!b) return;
      state.filter = b.dataset.f; renderFilters(); renderList();
    });
    $('#leagueFilter').addEventListener('change', (ev) => { state.league = ev.target.value; renderList(); });

    $('#list').addEventListener('click', (ev) => {
      if (ev.target.closest('[data-retry]')) { delete state.cache[dayKey(state.day)]; loadDay(state.day); return; }
      const more = ev.target.closest('[data-more]');
      if (more) { const id = more.dataset.more; state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id); renderList(); return; }
      const b = ev.target.closest('.odd'); if (!b || b.disabled) return;
      const e = state.byId.get(b.dataset.ev); if (!e || !isBettable(e)) return;
      toggleSelection(e, b.dataset.m, b.dataset.p);
      state.tab = 'slip';
      renderList(); renderSide();
    });

    document.querySelector('.tabs').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-tab]'); if (!b) return;
      state.tab = b.dataset.tab; renderSide();
    });

    $('#slipPanel').addEventListener('click', (ev) => {
      const t = ev.target;
      const rm = t.closest('[data-rm]');
      if (rm) { state.slip.splice(+rm.dataset.rm, 1); if (state.slip.length < 2) state.slipMode = 'single'; renderList(); renderSide(); return; }
      const m = t.closest('[data-mode]');
      if (m) { state.slipMode = m.dataset.mode; renderSlip(); return; }
      const chip = t.closest('[data-chip]');
      if (chip) {
        const mode = state.slip.length > 1 ? state.slipMode : 'single';
        let v = chip.dataset.chip;
        if (v === 'max') v = mode === 'multi' ? wallet.balance : Math.floor((wallet.balance / state.slip.length) * 100) / 100;
        v = round2(Math.max(0, Number(v)));
        if (mode === 'multi') state.multiStake = v; else { state.slip.forEach((s) => { s.stake = v; }); }
        if (chip.dataset.chip !== 'max') state.defaultStake = v;
        renderSlip(); return;
      }
      if (t.closest('#placeBtn')) { placeBets(); return; }
      if (t.closest('[data-clear]')) { state.slip = []; state.slipMode = 'single'; renderList(); renderSide(); }
    });
    $('#slipPanel').addEventListener('input', (ev) => {
      const t = ev.target;
      if (t.dataset.multi !== undefined) state.multiStake = t.value;
      else if (t.dataset.i !== undefined) state.slip[+t.dataset.i].stake = t.value;
      updateSlipTotals();
    });
    $('#slipPanel').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.classList.contains('stake')) placeBets(); });

    $('#betsPanel').addEventListener('click', (ev) => {
      const bv = ev.target.closest('[data-bv]');
      if (bv) { state.betsView = bv.dataset.bv; renderBets(); return; }
      if (ev.target.closest('[data-reset]')) {
        if (!confirm('Zerar carteira? Seu saldo volta a 1.000 estalecas e o histórico de apostas é apagado.')) return;
        wallet = { balance: START_BALANCE, bets: [], lastBonus: wallet.lastBonus, createdAt: Date.now() };
        saveWallet(); toast('Carteira zerada: 1.000 estalecas.', 'good'); bumpBalance(); renderSide();
      }
    });

    $('#bonusBtn').addEventListener('click', () => {
      const today = dayKey(new Date());
      if (wallet.lastBonus === today) return;
      wallet.lastBonus = today;
      wallet.balance = round2(wallet.balance + DAILY_BONUS);
      saveWallet(); toast(`+${DAILY_BONUS} estalecas de bônus diário 🪙`, 'good'); bumpBalance(); renderBalance(); updateSlipTotals();
    });

    $('#fab').addEventListener('click', () => { if (!state.slip.length) state.tab = 'bets'; renderSide(); openSheet(true); });
    $('#backdrop').addEventListener('click', () => openSheet(false));
    $('#sheetGrip').addEventListener('click', () => openSheet(false));

    document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadDay(state.day, true); syncPending(); } });
    window.addEventListener('storage', (ev) => { if (ev.key === STORE_KEY) { wallet = loadWallet(); renderAll(); } });
  }

  /* ---------------- início ---------------- */
  bind();
  renderAll();
  loadDay(state.day).then(syncPending);
  setInterval(syncPending, 180000);
})();
