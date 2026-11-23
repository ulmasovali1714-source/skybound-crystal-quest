
// SKYBOUND Mini App shell: the browser is presentation-only for balances/rewards.
const tg = window.Telegram?.WebApp ?? null;
const config = window.SKYBOUND_CONFIG ?? {};
const rawApiBase = String(config.apiBaseUrl || '').trim();
let API_BASE = '';
try {
  if (rawApiBase) {
    const parsed = new URL(rawApiBase);
    const localHost = ['localhost', '127.0.0.1'].includes(parsed.hostname);
    if (parsed.protocol === 'https:' || (localHost && parsed.protocol === 'http:')) API_BASE = parsed.toString().replace(/\/$/, '');
  }
} catch {
  API_BASE = '';
}

const state = {
  page: 'home',
  period: 'daily',
  telegramUser: tg?.initDataUnsafe?.user ?? null,
  initData: tg?.initData ?? '',
  profile: null,
  daily: null,
  tasks: [],
  achievements: [],
  tickets: null,
  referralLink: '',
  apiLoaded: false,
  apiError: '',
  activeRunId: null,
  pendingFinish: null,
  startLocked: false,
  finishLocked: false,
  abandonLocked: false,
  pendingStartKey: '',
  pendingDailyKey: '',
  pendingReferralKey: '',
  pendingTaskKeys: new Map(),
  lastResult: null,
  leaderboard: [],
  currentRank: null,
  leaderboardLoaded: false,
  tonUI: null,
  tonWallet: null,
  tonError: '',
  toastTimer: 0,
};

const $ = (id) => document.getElementById(id);
const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const numberText = (value) => integer(value) === null ? '—' : value.toLocaleString();
const randomKey = () => globalThis.crypto?.randomUUID?.() || `sb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const hasSecureSession = () => Boolean(API_BASE && state.initData);

function safeHttpsUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function telegramVersionAtLeast(version) {
  try { return Boolean(tg && typeof tg.isVersionAtLeast === 'function' && tg.isVersionAtLeast(version)); }
  catch { return false; }
}

function applyTelegramEnvironment() {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    // Telegram 6.0 logs warnings for these methods; they were added in later clients.
    if (telegramVersionAtLeast('6.1')) {
      tg.setHeaderColor?.('#0c0a19');
      tg.setBackgroundColor?.('#090816');
    }
    const updateViewport = () => {
      const h = tg.viewportStableHeight || tg.viewportHeight || window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${Math.max(320, h)}px`);
    };
    updateViewport();
    tg.onEvent?.('viewportChanged', updateViewport);
    tg.onEvent?.('themeChanged', applyTelegramTheme);
    applyTelegramTheme();
  } catch (error) {
    console.warn('Telegram WebApp setup could not complete.', error);
  }
}

function applyTelegramTheme() {
  if (!tg?.themeParams) return;
  const root = document.documentElement;
  const p = tg.themeParams;
  if (p.bg_color) root.style.setProperty('--telegram-bg', p.bg_color);
  if (p.text_color) root.style.setProperty('--telegram-text', p.text_color);
  if (p.hint_color) root.style.setProperty('--telegram-hint', p.hint_color);
}

function apiFailure(message, code = 'API_ERROR', status = 0, body = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.body = body;
  return error;
}

async function apiRequest(path, { method = 'GET', body, idempotencyKey, timeoutMs = 12000 } = {}) {
  if (!API_BASE) throw apiFailure('The secure Skybound API is not configured.', 'API_NOT_CONFIGURED');
  if (!state.initData) throw apiFailure('Open Skybound inside Telegram to authenticate your account.', 'TELEGRAM_REQUIRED');
  const headers = { 'X-Telegram-Init-Data': state.initData, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      throw apiFailure(payload?.message || `Skybound service returned ${response.status}.`, payload?.code || 'API_ERROR', response.status, payload);
    }
    return payload ?? {};
  } catch (error) {
    if (error.name === 'AbortError') throw apiFailure('The Skybound service took too long to respond. Please retry.', 'TIMEOUT');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function updateProfileFromResponse(data) {
  if (data?.user && typeof data.user === 'object') state.profile = data.user;
  if (integer(data?.ticketBalance) !== null) state.tickets = data.ticketBalance;
  else if (integer(data?.user?.tickets) !== null) state.tickets = data.user.tickets;
  if (data?.daily && typeof data.daily === 'object') state.daily = data.daily;
  if (Array.isArray(data?.tasks)) state.tasks = data.tasks;
  if (Array.isArray(data?.achievements)) state.achievements = data.achievements;
  if (typeof data?.referralLink === 'string') state.referralLink = safeHttpsUrl(data.referralLink);
  else if (typeof data?.user?.referralLink === 'string') state.referralLink = safeHttpsUrl(data.user.referralLink);
}

async function refreshBootstrap({ silent = false } = {}) {
  if (!hasSecureSession()) {
    render();
    return false;
  }
  try {
    const data = await apiRequest('/v1/me');
    updateProfileFromResponse(data);
    state.apiLoaded = true;
    state.apiError = '';
    render();
    return true;
  } catch (error) {
    state.apiLoaded = false;
    state.apiError = error.message;
    render();
    if (!silent) showToast(error.message);
    return false;
  }
}

function showToast(message) {
  const node = $('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('visible');
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => node.classList.remove('visible'), 3400);
}

function navigate(page) {
  if (!['home', 'earn', 'profile', 'score'].includes(page)) return;
  if (state.page === 'game') {
    showToast('Finish your expedition or exit the run before changing sections.');
    return;
  }
  showPage(page);
  if (page === 'score') loadLeaderboard(state.period);
}

function showPage(page) {
  state.page = page;
  document.querySelectorAll('.page').forEach((section) => {
    const active = section.id === `page-${page}`;
    section.classList.toggle('active', active);
    section.setAttribute('aria-hidden', String(!active));
  });
  document.querySelectorAll('[data-nav]').forEach((button) => {
    const active = button.dataset.nav === page;
    button.classList.toggle('active', active);
    if (button.classList.contains('nav-item')) button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  if (page === 'game') {
    requestAnimationFrame(() => window.dispatchEvent(new Event('skybound:layout')));
  }
  updateTelegramBackButton();
}

function updateTelegramBackButton() {
  if (!tg?.BackButton || !telegramVersionAtLeast('6.1')) return;
  const shouldShow = state.page !== 'home';
  try {
    if (shouldShow) tg.BackButton.show();
    else tg.BackButton.hide();
  } catch { /* Older Telegram clients may not expose BackButton. */ }
}

function formatStat(value) {
  return numberText(value);
}

function renderIdentity() {
  const user = state.profile || {};
  const telegramUser = state.telegramUser || {};
  const firstName = String(user.firstName || user.first_name || telegramUser.first_name || 'Sky Adventurer');
  const username = String(user.username || telegramUser.username || '');
  const profileName = String(user.firstName || user.first_name || telegramUser.first_name || 'Open in Telegram');
  const photo = safeHttpsUrl(user.photoUrl || user.photo_url || telegramUser.photo_url || '');
  setText('home-first-name', firstName);
  setText('profile-name', profileName);
  setText('profile-username', username ? `@${username}` : (state.telegramUser ? 'Telegram explorer' : 'Telegram account not detected'));
  const avatar = $('profile-avatar');
  if (avatar) avatar.src = photo || 'assets/crystal-gem.webp';
  const auth = $('telegram-auth-status');
  if (auth) {
    auth.textContent = state.apiLoaded ? 'SERVER VERIFIED' : (state.initData ? 'AWAITING SERVER' : 'UNVERIFIED');
    auth.dataset.auth = state.apiLoaded ? 'yes' : 'no';
  }
}

function renderTasks() {
  const list = $('task-list');
  const empty = $('earn-empty');
  if (!list || !empty) return;
  list.replaceChildren();
  for (const task of state.tasks) {
    if (!task || task.id === undefined || task.id === null) continue;
    const card = document.createElement('article');
    card.className = 'task-card';
    const top = document.createElement('div');
    top.className = 'task-card-top';
    const textGroup = document.createElement('div');
    const label = document.createElement('span');
    label.className = 'mini-label';
    label.textContent = String(task.category || task.type || 'SKY GUILD MISSION').toUpperCase();
    const title = document.createElement('h3');
    title.textContent = String(task.title || 'Guild mission');
    textGroup.append(label, title);
    const reward = document.createElement('span');
    reward.className = 'task-reward';
    const rewardCount = integer(task.rewardTickets);
    reward.textContent = rewardCount === null ? 'TICKET REWARD' : `+${rewardCount} ✦`;
    top.append(textGroup, reward);
    const desc = document.createElement('p');
    desc.textContent = String(task.description || 'Complete this mission and request server verification.');
    const meta = document.createElement('div');
    meta.className = 'task-meta';
    const progress = document.createElement('span');
    progress.textContent = String(task.progressText || task.statusText || (task.claimed ? 'Reward recorded' : 'Server verification required'));
    const action = document.createElement('button');
    action.type = 'button';
    action.dataset.action = 'task-claim';
    action.dataset.taskId = String(task.id);
    action.textContent = task.claimed ? 'CLAIMED' : (task.claimLabel || 'VERIFY & CLAIM');
    action.disabled = Boolean(task.claimed || state.pendingTaskKeys.has(String(task.id)));
    meta.append(progress, action);
    card.append(top, desc);
    const taskUrl = safeHttpsUrl(task.url || '');
    if (taskUrl && String(task.type || task.category || '').toLowerCase().includes('channel')) {
      const join = document.createElement('a');
      join.className = 'task-join-link';
      join.href = taskUrl;
      join.target = '_blank';
      join.rel = 'noopener noreferrer';
      join.textContent = 'OPEN CHANNEL ↗';
      join.addEventListener('click', (event) => {
        if (tg?.openTelegramLink && telegramVersionAtLeast('6.1') && taskUrl.includes('t.me/')) {
          event.preventDefault();
          tg.openTelegramLink(taskUrl);
        }
      });
      card.append(join);
    }
    card.append(meta);
    list.append(card);
  }
  empty.hidden = list.childElementCount > 0;
}

function renderAchievements() {
  const list = $('achievement-list');
  const empty = $('achievement-empty');
  if (!list || !empty) return;
  list.replaceChildren();
  for (const achievement of state.achievements) {
    const card = document.createElement('article');
    card.className = 'achievement-card';
    const icon = document.createElement('span');
    icon.className = 'achievement-icon';
    icon.textContent = String(achievement.icon || '✦');
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = String(achievement.title || 'Sky milestone');
    const detail = document.createElement('small');
    detail.textContent = String(achievement.description || (achievement.unlocked ? 'Unlocked' : 'Locked'));
    copy.append(title, detail);
    card.append(icon, copy);
    list.append(card);
  }
  empty.hidden = list.childElementCount > 0;
}

function render() {
  renderIdentity();
  const profile = state.profile || {};
  const tickets = state.tickets;
  const ticketText = integer(tickets) === null ? '—' : tickets.toLocaleString();
  setText('header-tickets', ticketText);
  setText('home-tickets', ticketText);
  setText('profile-tickets', ticketText);
  setText('home-best', formatStat(profile.bestScore));
  setText('home-crystals', formatStat(profile.totalCrystals));
  setText('home-games', formatStat(profile.gamesPlayed));
  setText('profile-best', formatStat(profile.bestScore));
  setText('profile-crystals', formatStat(profile.totalCrystals));
  setText('profile-games', formatStat(profile.gamesPlayed));

  const ticketStatus = $('ticket-status');
  if (ticketStatus) {
    const value = !API_BASE ? 'API SETUP' : (!state.initData ? 'OPEN TELEGRAM' : (integer(tickets) === null ? 'LOADING' : (tickets > 0 ? 'READY' : 'NO TICKETS')));
    ticketStatus.textContent = value;
    ticketStatus.dataset.state = tickets > 0 ? 'ready' : (tickets === 0 ? 'error' : '');
  }

  if (state.daily) {
    const available = state.daily.available === true;
    setText('daily-home-status', available ? 'Your free ticket gift is ready to claim.' : (state.daily.nextClaimAt ? 'Your next chest opens after the 24-hour cooldown.' : 'Daily claim status is set by the server.'));
    setText('daily-status', available ? 'READY TO CLAIM' : 'COOLDOWN ACTIVE');
    setText('daily-description', available ? 'The server has confirmed your daily chest is ready.' : 'One claim every 24 hours. The server controls the cooldown.');
    const amount = integer(state.daily.rewardTickets);
    setText('daily-reward-amount', amount === null ? 'Server-set' : `+${amount} tickets`);
  } else {
    setText('daily-home-status', API_BASE ? 'Sign in to load your verified daily reward.' : 'Connect the secure service to check today’s reward.');
    setText('daily-status', 'SERVER CHECK REQUIRED');
    setText('daily-description', 'Rewards and cooldowns are verified by the backend, never by this screen.');
    setText('daily-reward-amount', '—');
  }

  const referralNode = $('referral-link');
  if (referralNode) referralNode.textContent = state.referralLink || 'Your verified invite link appears here';
  const accountNote = !API_BASE
    ? 'Secure backend not connected. Tickets, rewards and official stats remain unavailable until configured.'
    : (!state.initData ? 'Open this Mini App from Telegram to authenticate securely.' : (state.apiLoaded ? 'Account data loaded from the authenticated Skybound service.' : 'Waiting for the authenticated Skybound service.'));
  setText('home-account-note', accountNote);
  setText('profile-account-note', accountNote);

  if (state.lastResult) {
    $('last-result-card').hidden = false;
    setText('last-result-text', state.lastResult.text);
  } else {
    $('last-result-card').hidden = true;
  }
  renderTasks();
  renderAchievements();
  renderWallet();
}
  
function showConfirm(title, message, confirmLabel, onConfirm) {
  const layer = $('dialog-layer');
  const card = document.createElement('div');
  card.className = 'dialog-card';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const copy = document.createElement('p');
  copy.textContent = message;
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'CANCEL';
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'confirm';
  confirm.textContent = confirmLabel;
  const close = () => {
    layer.hidden = true;
    layer.replaceChildren();
  };
  cancel.addEventListener('click', close);
  confirm.addEventListener('click', async () => {
    close();
    await onConfirm();
  });
  actions.append(cancel, confirm);
  card.append(heading, copy, actions);
  layer.replaceChildren(card);
  layer.hidden = false;
  layer.addEventListener('click', (event) => {
    if (event.target === layer) close();
  }, { once: true });
}

function updateAuthoritativeBalances(data) {
  updateProfileFromResponse(data);
  render();
}

async function startGame() {
  if (state.startLocked || state.finishLocked || state.abandonLocked) return;
  if (state.pendingFinish) {
    showToast('Your previous run is still awaiting server confirmation. Reconnect and retry first.');
    return;
  }
  if (!state.initData) {
    showToast('Open this Mini App inside Telegram to authenticate your account.');
    return;
  }
  if (!API_BASE) {
    showToast('Secure ticket service is not connected. No game was started.');
    return;
  }
  if (state.tickets === 0) {
    showToast('Not enough tickets! Visit EARN to get more.');
    return;
  }
  if (integer(state.tickets) === null) {
    const loaded = await refreshBootstrap({ silent: true });
    if (!loaded || integer(state.tickets) === null) {
      showToast('Ticket balance could not be verified. No game was started.');
      return;
    }
    if (state.tickets === 0) {
      showToast('Not enough tickets! Visit EARN to get more.');
      return;
    }
  }

  state.startLocked = true;
  const button = $('start-game');
  button.disabled = true;
  button.querySelector('span').textContent = 'RESERVING TICKET…';
  if (!state.pendingStartKey) state.pendingStartKey = randomKey();
  render();
  try {
    // The backend must debit exactly one ticket in the same transaction that creates this run.
    const data = await apiRequest('/v1/game/start', {
      method: 'POST',
      body: { idempotencyKey: state.pendingStartKey },
      idempotencyKey: state.pendingStartKey,
    });
    if (typeof data.runId !== 'string' || !data.runId || integer(data.ticketBalance) === null ||
        data.ticketCost !== 1 || integer(data.seed) === null || data.seed > 0xffffffff) {
      throw apiFailure('The server did not confirm exactly one ticket charge and a valid seeded run. No flight was launched.', 'INVALID_START_RESPONSE');
    }
    state.pendingStartKey = '';
    state.activeRunId = data.runId;
    state.tickets = data.ticketBalance;
    if (data.user) state.profile = data.user;
    state.lastResult = null;
    showPage('game');
    render();
    window.dispatchEvent(new CustomEvent('skybound:launch', {
      detail: { runId: data.runId, seed: data.seed }
    }));
  } catch (error) {
    if (error.code === 'NOT_ENOUGH_TICKETS' || error.body?.code === 'NOT_ENOUGH_TICKETS') {
      if (integer(error.body?.ticketBalance) !== null) state.tickets = error.body.ticketBalance;
      showToast('Not enough tickets! Visit EARN to get more.');
    } else {
      showToast(error.message || 'The run could not be verified. No game was started.');
    }
  } finally {
    state.startLocked = false;
    button.disabled = false;
    button.querySelector('span').textContent = 'START GAME';
    render();
  }
}

async function claimDaily() {
  if (!hasSecureSession()) {
    showToast(!API_BASE ? 'Secure rewards are unavailable until the backend is connected.' : 'Open this Mini App inside Telegram to authenticate.');
    return;
  }
  if (state.daily?.available === false) {
    showToast('Daily reward already claimed. Check back after the 24-hour cooldown.');
    return;
  }
  const buttons = document.querySelectorAll('[data-action="daily-claim"]');
  buttons.forEach((button) => { button.disabled = true; });
  if (!state.pendingDailyKey) state.pendingDailyKey = randomKey();
  try {
    const result = await apiRequest('/v1/rewards/daily/claim', {
      method: 'POST',
      body: { idempotencyKey: state.pendingDailyKey },
      idempotencyKey: state.pendingDailyKey,
    });
    state.pendingDailyKey = '';
    updateAuthoritativeBalances(result);
    showToast(result.message || 'Daily reward confirmed by Skybound.');
    await refreshBootstrap({ silent: true });
  } catch (error) {
    if (error.body?.ticketBalance !== undefined) updateAuthoritativeBalances(error.body);
    showToast(error.message || 'Daily reward could not be verified.');
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function verifyReferrals() {
  if (!hasSecureSession()) {
    showToast('Secure referral verification is not connected.');
    return;
  }
  if (!state.pendingReferralKey) state.pendingReferralKey = randomKey();
  $('verify-referral').disabled = true;
  try {
    const result = await apiRequest('/v1/referrals/claim', {
      method: 'POST',
      body: { idempotencyKey: state.pendingReferralKey },
      idempotencyKey: state.pendingReferralKey,
    });
    state.pendingReferralKey = '';
    updateAuthoritativeBalances(result);
    showToast(result.message || 'Referral status checked by the server.');
    await refreshBootstrap({ silent: true });
  } catch (error) {
    showToast(error.message || 'Referral rewards could not be verified.');
  } finally {
    $('verify-referral').disabled = false;
  }
}

async function claimTask(taskId, button) {
  if (!hasSecureSession()) {
    showToast('Secure mission verification is not connected.');
    return;
  }
  const id = String(taskId);
  let key = state.pendingTaskKeys.get(id);
  if (!key) {
    key = randomKey();
    state.pendingTaskKeys.set(id, key);
  }
  button.disabled = true;
  try {
    const result = await apiRequest(`/v1/tasks/${encodeURIComponent(id)}/claim`, {
      method: 'POST',
      body: { idempotencyKey: key },
      idempotencyKey: key,
    });
    state.pendingTaskKeys.delete(id);
    updateAuthoritativeBalances(result);
    showToast(result.message || 'Mission claim verified by the server.');
    await refreshBootstrap({ silent: true });
  } catch (error) {
    showToast(error.message || 'Mission could not be verified.');
    button.disabled = false;
  }
}

async function shareReferral() {
  if (!state.referralLink) {
    showToast('A personal invite link is available after secure account setup.');
    return;
  }
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(state.referralLink)}&text=${encodeURIComponent('Join me in Skybound: Crystal Quest!')}`;
  if (tg?.openTelegramLink && telegramVersionAtLeast('6.1')) {
    tg.openTelegramLink(shareUrl);
  } else if (navigator.share) {
    try {
      await navigator.share({
        title: 'Skybound: Crystal Quest',
        text: 'Join me in Skybound!',
        url: state.referralLink
      });
    } catch (error) {
      if (error.name !== 'AbortError') showToast('Invite sharing was cancelled.');
    }
  } else {
    await copyReferral();
  }
}

async function copyReferral() {
  if (!state.referralLink) {
    showToast('Your verified invite link is not available yet.');
    return;
  }
  try {
    await navigator.clipboard.writeText(state.referralLink);
    showToast('Personal invite link copied.');
  } catch {
    showToast('Could not copy the link. Use Invite Friends instead.');
  }
}

function renderLeaderboardRows() {
  const list = $('leaderboard-list');
  const empty = $('leaderboard-empty');
  if (!list || !empty) return;
  list.replaceChildren();
  for (const row of state.leaderboard.slice(0, 100)) {
    const item = document.createElement('article');
    item.className = `leader-row${row.isCurrentPlayer ? ' current' : ''}`;
    const rank = document.createElement('span');
    rank.className = `leader-rank${Number(row.rank) <= 3 ? ' top' : ''}`;
    rank.textContent = Number.isInteger(row.rank) ? `#${row.rank}` : '—';
    const image = document.createElement('img');
    image.className = 'leader-avatar';
    image.alt = '';
    image.src = safeHttpsUrl(row.photoUrl) || 'assets/crystal-gem.webp';
    image.onerror = () => {
      image.onerror = null;
      image.src = 'assets/crystal-gem.webp';
    };
    const identity = document.createElement('div');
    identity.className = 'leader-identity';
    const name = document.createElement('strong');
    name.textContent = String(row.displayName || row.username || 'Sky Pilot');
    const username = document.createElement('small');
    username.textContent = row.isCurrentPlayer
      ? 'YOU · VERIFIED PILOT'
      : (row.username ? `@${String(row.username).replace(/^@/, '')}` : 'Verified pilot');
    identity.append(name, username);
    const score = document.createElement('span');
    score.className = 'leader-score';
    score.textContent = formatStat(row.bestScore);
    item.append(rank, image, identity, score);
    list.append(item);
  }
  empty.hidden = list.childElementCount > 0;
  setText('my-rank', state.currentRank ? `#${state.currentRank}` : '—');
}

async function loadLeaderboard(period = state.period) {
  state.period = period;
  document.querySelectorAll('.leader-tab').forEach((tab) => {
    const active = tab.dataset.period === period;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  setText('leaderboard-period-label', period.toUpperCase());
  if (!hasSecureSession()) {
    state.leaderboard = [];
    state.currentRank = null;
    state.leaderboardLoaded = false;
    renderLeaderboardRows();
    showLeaderboardLoading();
    return;
  }
  const loadingEmpty = $('leaderboard-empty');
  loadingEmpty.querySelector('h3').textContent = 'Loading verified rankings…';
  loadingEmpty.querySelector('p').textContent = 'Fetching the selected period from the Skybound service.';
  loadingEmpty.hidden = false;
  try {
    const data = await apiRequest(`/v1/leaderboard?period=${encodeURIComponent(period)}&limit=100`);
    state.leaderboard = Array.isArray(data.entries) ? data.entries : [];
    state.currentRank = integer(data.currentPlayerRank);
    state.leaderboardLoaded = true;
    renderLeaderboardRows();
    if (state.leaderboard.length === 0) {
      $('leaderboard-empty').querySelector('h3').textContent = 'No verified scores yet';
      $('leaderboard-empty').querySelector('p').textContent = 'No players have a verified score for this period.';
    }
  } catch (error) {
    state.leaderboard = [];
    state.currentRank = null;
    state.leaderboardLoaded = false;
    renderLeaderboardRows();
    const empty = $('leaderboard-empty');
    empty.hidden = false;
    empty.querySelector('h3').textContent = 'Rankings unavailable';
    empty.querySelector('p').textContent = error.message || 'The authenticated leaderboard could not be loaded.';
  }
}

function showLeaderboardLoading() {
  const empty = $('leaderboard-empty');
  if (!empty) return;
  const title = empty.querySelector('h3');
  const copy = empty.querySelector('p');
  if (title) title.textContent = 'Rankings not connected';
  if (copy) copy.textContent = 'The leaderboard will show real verified pilots as soon as the authenticated backend is configured.';
                           }
    
function onGameOver(event) {
  const report = event.detail || {};
  const runId = String(report.runId || '');
  if (!state.activeRunId || runId !== state.activeRunId || state.pendingFinish) return;

  const score = integer(report.score) ?? 0;
  const collected = integer(report.crystals) ?? 0;
  const clientReport = {
    score,
    crystals: collected,
    elapsedMs: integer(report.elapsedMs) ?? 0,
    seed: integer(report.seed),
    randomAlgorithm: String(report.randomAlgorithm || ''),
    inputEvents: Array.isArray(report.inputEvents) ? report.inputEvents.slice(0, 12000) : [],
  };

  // Preserve the run and report until the server confirms receipt.
  state.pendingFinish = { runId, clientReport };
  state.finishLocked = true;
  state.lastResult = {
    text: `Score ${score.toLocaleString()} · ${collected.toLocaleString()} crystals collected · verifying with server…`
  };

  showPage('home');
  render();
  window.dispatchEvent(new Event('skybound:stop'));
  void finishRun(runId, clientReport);
}

async function finishRun(runId, clientReport) {
  if (state.finishLocked && state.pendingFinish?.runId !== runId) return;
  state.finishLocked = true;

  try {
    const result = await apiRequest('/v1/game/finish', {
      method: 'POST',
      body: { runId, clientReport },
      idempotencyKey: runId,
      timeoutMs: 20000,
    });

    if (result.user) state.profile = result.user;
    if (integer(result.ticketBalance) !== null) state.tickets = result.ticketBalance;

    if (result.verified === true) {
      const awarded = integer(result.awardedCrystals);
      state.lastResult = {
        text: `Verified score ${formatStat(result.score ?? clientReport.score)} · ${awarded === null ? 'crystal award confirmed' : `+${awarded} crystals credited`}.`
      };
    } else {
      state.lastResult = {
        text: 'Run received. The server has not confirmed a score or crystal credit yet.'
      };
    }

    // A successful response means the server has handled this run.
    if (state.pendingFinish?.runId === runId) state.pendingFinish = null;
    if (state.activeRunId === runId) state.activeRunId = null;

    render();
    await refreshBootstrap({ silent: true });
  } catch (error) {
    state.lastResult = {
      text: `Run report not confirmed (${clientReport.score.toLocaleString()} score, ${clientReport.crystals.toLocaleString()} crystals collected). The report is saved on this screen for retry. No unverified reward was added.`
    };
    render();
    showToast(error.message || 'The run could not be verified. Reconnect to retry.');
  } finally {
    state.finishLocked = false;
    render();
  }
}

async function retryPendingFinish() {
  if (!state.pendingFinish || state.finishLocked || !hasSecureSession()) return;
  const pending = state.pendingFinish;
  await finishRun(pending.runId, pending.clientReport);
}

async function exitRun() {
  if (!state.activeRunId || state.abandonLocked) return;

  showConfirm(
    'Leave this expedition?',
    'Your ticket has already been reserved. Leaving will end the run and does not refund that ticket.',
    'EXIT RUN',
    async () => {
      state.abandonLocked = true;
      const runId = state.activeRunId;

      try {
        await apiRequest('/v1/game/abandon', {
          method: 'POST',
          body: { runId },
          idempotencyKey: runId,
        });

        state.lastResult = {
          text: 'Expedition ended early. The reserved ticket was not refunded.'
        };
        state.activeRunId = null;
        window.dispatchEvent(new Event('skybound:stop'));
        showPage('home');
        render();
        await refreshBootstrap({ silent: true });
      } catch (error) {
        // Keep activeRunId so the app does not forget an unconfirmed server run.
        showToast(error.message || 'Server could not confirm run closure. Your expedition remains active.');
      } finally {
        state.abandonLocked = false;
      }
    }
  );
}

function setupBackButton() {
  if (!tg?.BackButton?.onClick || !telegramVersionAtLeast('6.1')) return;
  tg.BackButton.onClick(() => {
    if (state.page === 'game') exitRun();
    else if (state.page !== 'home') showPage('home');
  });
}

async function setupTonConnect() {
  const manifestUrl = safeHttpsUrl(String(config.tonConnectManifestUrl || ''));
  const button = $('wallet-button');

  button?.addEventListener('click', async () => {
    if (!state.tonUI) {
      showToast(state.tonError || 'TON Connect is not configured.');
      return;
    }
    try {
      if (state.tonWallet) await state.tonUI.disconnect();
      else await state.tonUI.openModal();
    } catch (error) {
      showToast(error.message || 'Wallet connection was not completed.');
    }
  });

  if (!manifestUrl) {
    state.tonError = 'Configure a public HTTPS TON Connect manifest before connecting wallets.';
    renderWallet();
    return;
  }

  try {
    const tonModule = await import('@tonconnect/ui');
    const TonConnectUI = Reflect.get(tonModule, 'TonConnectUI');
    if (typeof TonConnectUI !== 'function') {
      throw new Error('TON Connect UI constructor was not exported by the module.');
    }
    state.tonUI = new TonConnectUI({ manifestUrl });
    state.tonUI.onStatusChange((wallet) => {
      state.tonWallet = wallet || null;
      renderWallet();
    });
    state.tonWallet = state.tonUI.wallet || null;
    renderWallet();
  } catch (error) {
    state.tonError = `TON Connect could not load: ${error.message || 'network error'}`;
    renderWallet();
  }
}

function renderWallet() {
  const wallet = state.tonWallet;
  const address = wallet?.account?.address || '';
  const status = $('wallet-status');
  const button = $('wallet-button');

  if (status) {
    status.textContent = address ? 'CONNECTED · LOCAL' : (state.tonError ? 'SETUP REQUIRED' : 'NOT CONNECTED');
    status.dataset.state = address ? 'ready' : '';
  }

  setText(
    'wallet-address',
    address
      ? `${address.slice(0, 12)}…${address.slice(-10)} · locally connected. Verify TON proof on the backend before treating it as an account credential.`
      : 'Connect a wallet to see its public address. Skybound will never ask for secret keys.'
  );

  if (button) button.textContent = address ? 'DISCONNECT WALLET' : 'CONNECT TON WALLET';
}

function wireEvents() {
  document.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      navigate(nav.dataset.nav);
      return;
    }

    const action = event.target.closest('[data-action]');
    if (action?.dataset.action === 'daily-claim') {
      void claimDaily();
      return;
    }
    if (action?.dataset.action === 'task-claim') {
      void claimTask(action.dataset.taskId, action);
      return;
    }

    const period = event.target.closest('[data-period]');
    if (period) void loadLeaderboard(period.dataset.period);
  });

  $('start-game').addEventListener('click', () => void startGame());
  $('copy-referral').addEventListener('click', () => void copyReferral());
  $('share-referral').addEventListener('click', () => void shareReferral());
  $('verify-referral').addEventListener('click', () => void verifyReferrals());
  $('refresh-leaderboard').addEventListener('click', () => void loadLeaderboard(state.period));
  $('exit-game').addEventListener('click', () => exitRun());

  window.addEventListener('skybound:gameover', onGameOver);

  window.addEventListener('online', () => {
    if (state.pendingFinish) {
      void retryPendingFinish();
    } else if (hasSecureSession()) {
      void refreshBootstrap({ silent: true });
    }
  });
}

async function loadScreenAssets() {
  const assets = [
    'assets/hero-fly.webp',
    'assets/sky-bg.webp',
    'assets/islands-layer.webp',
    'assets/crystal-pillar.webp',
    'assets/crystal-gem.webp',
    'assets/hanging-crystal-saw.webp',
    'assets/giant-crystal-blade.webp',
  ];

  let completed = 0;
  const bar = $('loading-progress');
  const percent = $('loading-percent');

  const updateProgress = (value) => {
    const safe = Math.max(0, Math.min(100, Math.round(value)));
    bar.style.width = `${safe}%`;
    percent.textContent = `${safe}%`;
  };

  const imageLoads = assets.map((src) => new Promise((resolve) => {
    const image = new Image();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      completed++;
      updateProgress((completed / assets.length) * 88);
      resolve();
    };

    image.onload = finish;
    image.onerror = finish;
    image.src = src;
    if (image.complete) finish();
  }));

  let softProgress = 0;
  const progressTimer = window.setInterval(() => {
    softProgress = Math.min(84, softProgress + 2 + Math.random() * 4);
    updateProgress(Math.max((completed / assets.length) * 88, softProgress));
  }, 80);

  const minDuration = new Promise((resolve) => window.setTimeout(resolve, 1050));
  await Promise.all([Promise.all(imageLoads), minDuration]);
  window.clearInterval(progressTimer);
  updateProgress(100);

  await new Promise((resolve) => window.setTimeout(resolve, 220));
  $('loading-screen').classList.add('loading-complete');

  window.setTimeout(() => {
    $('loading-screen').hidden = true;
    $('app-shell').hidden = false;
    showPage('home');
    render();
  }, 300);
}

applyTelegramEnvironment();
setupBackButton();
wireEvents();
render();
showLeaderboardLoading();
void setupTonConnect();
if (hasSecureSession()) void refreshBootstrap({ silent: true });
void loadScreenAssets();
    
