const $ = (sel, root = document) => root.querySelector(sel);

const STATUS = {
  queued: 'Queued',
  posting: 'Posting…',
  awaiting_review: 'Review in browser',
  listed: 'Listed',
  failed: 'Failed',
  delisted: 'Delisted',
  delist_manually: 'Delist manually',
};
const BUSY = ['queued', 'posting', 'awaiting_review'];
const CONDITION = { new: 'New', like_new: 'Like new', good: 'Good', fair: 'Fair', poor: 'Poor' };

let appConfig = { platforms: [], facebookCategories: [] };
let items = [];
let editing = null; // item being edited, or null for new
let pendingFiles = [];
let pollTimer;

const els = {
  items: $('#items'),
  badges: $('#badges'),
  notice: $('#notice'),
  search: $('#search'),
  showSold: $('#show-sold'),
  dialog: $('#editor'),
  form: $('#item-form'),
  photoGrid: $('#photo-grid'),
  photoInput: $('#photo-input'),
  formError: $('#form-error'),
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const money = (cents) => `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

const postJson = (path, data) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}) });

function showNotice(message) {
  els.notice.textContent = message;
  els.notice.hidden = !message;
  if (message) setTimeout(() => (els.notice.hidden = true), 8000);
}

// ---------- Rendering ----------

function renderBadges() {
  const { postMode, ebay } = appConfig;
  const badges = [
    `<span class="badge">${postMode === 'auto' ? 'Auto-publish' : 'Review before publish'}</span>`,
  ];
  if (!ebay.connected) badges.push(`<span class="badge warn">eBay ${esc(ebay.env)}: not connected</span>`);
  else if (ebay.missing.length) badges.push(`<span class="badge warn">eBay ${esc(ebay.env)}: missing policies</span>`);
  else badges.push(`<span class="badge">eBay ${esc(ebay.env)}</span>`);
  els.badges.innerHTML = badges.join('');
}

function channelHtml(item, platform) {
  const listing = item.listings.find((l) => l.platform === platform.id);
  const status = listing?.status;
  const busy = BUSY.includes(status);
  const isError = status === 'failed' || status === 'delist_manually';
  let action = '';
  if (item.status !== 'sold' && !busy) {
    const label = !status ? 'Post' : status === 'failed' ? 'Retry' : status === 'listed' ? 'Update' : 'Repost';
    // Re-running Facebook/Poshmark creates a duplicate listing; eBay updates in place.
    if (!(status === 'listed' && platform.id !== 'ebay')) {
      action = `<button class="small" data-action="post" data-platform="${platform.id}">${label}</button>`;
    }
  }
  if (status === 'delist_manually') {
    action += `<button class="small" data-action="delisted" data-platform="${platform.id}">Done</button>`;
  }
  return `
    <div class="channel">
      <div class="channel-head">
        <span class="channel-name">${esc(platform.label.replace(' Marketplace', ''))}</span>
        <span class="pill ${esc(status ?? '')}">${esc(STATUS[status] ?? 'Not posted')}</span>
      </div>
      ${listing?.message ? `<div class="channel-msg ${isError ? 'error' : ''}">${esc(listing.message)}</div>` : ''}
      <div class="channel-actions">
        ${action}
        ${listing?.url && status === 'listed' ? `<a href="${esc(listing.url)}" target="_blank" rel="noopener">View ↗</a>` : ''}
      </div>
    </div>`;
}

function itemHtml(item) {
  const cover = item.photos[0];
  const sold = item.status === 'sold';
  const meta = [
    `<span class="price">${money(item.price_cents)}</span>`,
    esc(CONDITION[item.condition]),
    item.brand && esc(item.brand),
    item.size && `Size ${esc(item.size)}`,
    `SKU ${esc(item.sku)}`,
    sold && '<strong>Sold</strong>',
  ].filter(Boolean);
  return `
    <article class="item ${sold ? 'sold' : ''}" data-id="${item.id}">
      ${cover ? `<img class="thumb" src="/uploads/${esc(cover.filename)}" alt="" loading="lazy" />` : '<div class="thumb empty">No photo</div>'}
      <div class="info">
        <h3 title="${esc(item.title)}">${esc(item.title)}</h3>
        <p class="meta">${meta.join(' · ')}</p>
        <div class="channels">${appConfig.platforms.map((p) => channelHtml(item, p)).join('')}</div>
      </div>
      <div class="actions">
        ${sold ? '' : '<button class="primary" data-action="post-all">Post to all</button>'}
        <button data-action="edit">Edit</button>
        ${sold ? '<button data-action="relist">Unmark sold</button>' : '<button data-action="sold">Mark sold</button>'}
        <button class="danger" data-action="delete">Delete</button>
      </div>
    </article>`;
}

function render() {
  const q = els.search.value.trim().toLowerCase();
  const visible = items.filter(
    (i) =>
      (els.showSold.checked || i.status !== 'sold') &&
      (!q || [i.title, i.sku, i.brand].some((v) => v.toLowerCase().includes(q))),
  );
  if (!items.length) {
    els.items.innerHTML = `
      <div class="empty-state">
        <p>No items yet. Add photos and details once, then post to eBay, Facebook and Poshmark.</p>
        <button class="primary" data-action="new">+ Add your first item</button>
      </div>`;
    return;
  }
  els.items.innerHTML = visible.length
    ? visible.map(itemHtml).join('')
    : '<div class="empty-state"><p>No items match.</p></div>';
}

// ---------- Data ----------

async function load() {
  try {
    items = await api('/api/items');
    render();
  } catch (err) {
    showNotice(`Couldn't load items: ${err.message}`);
  }
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = items.some((i) => i.listings.some((l) => BUSY.includes(l.status)));
  pollTimer = setTimeout(load, busy ? 2000 : 15000);
}

function replaceItem(updated) {
  const idx = items.findIndex((i) => i.id === updated.id);
  if (idx >= 0) items[idx] = updated;
  else items.unshift(updated);
  render();
  schedulePoll();
}

async function postItem(item, platforms) {
  replaceItem(await postJson(`/api/items/${item.id}/post`, { platforms }));
}

// ---------- Item list actions ----------

els.items.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { action, platform } = button.dataset;
  if (action === 'new') return openEditor(null);

  const item = items.find((i) => i.id === Number(button.closest('[data-id]')?.dataset.id));
  if (!item) return;
  button.disabled = true;
  try {
    if (action === 'post-all') await postItem(item, appConfig.platforms.map((p) => p.id));
    if (action === 'post') await postItem(item, [platform]);
    if (action === 'edit') openEditor(item);
    if (action === 'sold') replaceItem(await postJson(`/api/items/${item.id}/sold`));
    if (action === 'relist') replaceItem(await postJson(`/api/items/${item.id}/relist`));
    if (action === 'delisted') replaceItem(await postJson(`/api/items/${item.id}/listings/${platform}/delisted`));
    if (action === 'delete' && confirm(`Delete "${item.title}"? Live listings are not removed.`)) {
      await api(`/api/items/${item.id}`, { method: 'DELETE' });
      items = items.filter((i) => i.id !== item.id);
      render();
    }
  } catch (err) {
    showNotice(err.message);
  } finally {
    button.disabled = false;
  }
});

els.search.addEventListener('input', render);
els.showSold.addEventListener('change', render);
$('#new-item').addEventListener('click', () => openEditor(null));

// ---------- Editor ----------

function renderPhotos() {
  const existing = (editing?.photos ?? []).map(
    (p, i) => `
      <div class="photo">
        <img src="/uploads/${esc(p.filename)}" alt="" />
        ${i === 0 ? '<span class="cover-tag">Cover</span>' : ''}
        <div class="photo-btns">
          ${i > 0 ? `<button type="button" data-cover="${p.id}" title="Make cover">★</button>` : ''}
          <button type="button" data-remove-photo="${p.id}" title="Remove">✕</button>
        </div>
      </div>`,
  );
  const pending = pendingFiles.map(
    (f, i) => `
      <div class="photo pending" title="Uploads when you save">
        <img src="${f.preview}" alt="" />
        <div class="photo-btns"><button type="button" data-remove-pending="${i}" title="Remove">✕</button></div>
      </div>`,
  );
  els.photoGrid.innerHTML = [...existing, ...pending].join('');
}

function setTitleCount() {
  const len = els.form.elements.title.value.length;
  const counter = $('#title-count');
  counter.textContent = `${len}/80`;
  counter.classList.toggle('over', len > 80);
}

function openEditor(item) {
  editing = item;
  pendingFiles.forEach((f) => URL.revokeObjectURL(f.preview));
  pendingFiles = [];
  els.form.reset();
  els.formError.hidden = true;
  $('#editor-title').textContent = item ? 'Edit item' : 'New item';

  if (item) {
    const f = els.form.elements;
    for (const key of ['title', 'description', 'quantity', 'condition', 'brand', 'size', 'color', 'sku', 'ebay_category_id', 'ebay_aspects', 'facebook_category', 'poshmark_category']) {
      f[key].value = item[key] ?? '';
    }
    f.price.value = (item.price_cents / 100).toFixed(2);
    f.original_price.value = item.original_price_cents ? (item.original_price_cents / 100).toFixed(2) : '';
    f.weight_oz.value = item.weight_oz ?? '';
  }
  setTitleCount();
  renderPhotos();
  els.dialog.showModal();
}

els.form.elements.title.addEventListener('input', setTitleCount);

els.photoInput.addEventListener('change', () => {
  for (const file of els.photoInput.files) {
    pendingFiles.push(Object.assign(file, { preview: URL.createObjectURL(file) }));
  }
  els.photoInput.value = '';
  renderPhotos();
});

els.photoGrid.addEventListener('click', async (event) => {
  const btn = event.target.closest('button');
  if (!btn) return;
  try {
    if (btn.dataset.removePending !== undefined) {
      const [removed] = pendingFiles.splice(Number(btn.dataset.removePending), 1);
      URL.revokeObjectURL(removed.preview);
    } else if (btn.dataset.removePhoto) {
      editing = await api(`/api/items/${editing.id}/photos/${btn.dataset.removePhoto}`, { method: 'DELETE' });
      replaceItem(editing);
    } else if (btn.dataset.cover) {
      editing = await postJson(`/api/items/${editing.id}/photos/${btn.dataset.cover}/cover`);
      replaceItem(editing);
    }
    renderPhotos();
  } catch (err) {
    els.formError.textContent = err.message;
    els.formError.hidden = false;
  }
});

els.dialog.addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) els.dialog.close();
});

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const andPost = event.submitter?.value === 'save-post';
  const data = new FormData(els.form);
  data.delete('photos');
  pendingFiles.forEach((file) => data.append('photos', file, file.name));

  if (andPost && !pendingFiles.length && !editing?.photos.length) {
    els.formError.textContent = 'Add at least one photo before posting.';
    els.formError.hidden = false;
    return;
  }

  const buttons = els.form.querySelectorAll('.dialog-foot button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    const saved = await api(editing ? `/api/items/${editing.id}` : '/api/items', {
      method: editing ? 'PUT' : 'POST',
      body: data,
    });
    replaceItem(saved);
    els.dialog.close();
    if (andPost) await postItem(saved, appConfig.platforms.map((p) => p.id));
  } catch (err) {
    els.formError.textContent = err.message;
    els.formError.hidden = false;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});

// ---------- Boot ----------

appConfig = await api('/api/config');
$('#fb-categories').innerHTML = appConfig.facebookCategories.map((c) => `<option value="${esc(c)}">`).join('');
renderBadges();
await load();
