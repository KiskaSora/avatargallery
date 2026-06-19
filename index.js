// ===== Avatar Gallery =====
// Галерея аватарок прямо в SillyTavern. На аватарках (персоны, персонаж, аватары
// в сообщениях, список персонажей) — значок 🖼. Клик → набор картинок для ЭТОЙ
// аватарки; выбор реально заменяет аватарку персоны/персонажа в таверне (везде).
// В меню-палочке — «Менеджер аватарок» со всеми сохранёнными. Хранение: IndexedDB
// (без раздувания settings.json). Дизайн адаптируется под тему ST.
(async function () {
    'use strict';

    let _ext, _script, _personas, _power;
    try { _ext      = await import('../../../extensions.js'); } catch {}
    try { _script   = await import('../../../../script.js');  } catch {}
    try { _personas = await import('../../../personas.js');   } catch {}
    try { _power    = await import('../../../power-user.js'); } catch {}

    const MY_KEY = 'avatar-gallery';
    const STORE_MAX = 1024;

    // ── Настройки ───────────────────────────────────────────────────────────
    function ctx() { try { return window.SillyTavern?.getContext?.() ?? null; } catch { return null; } }
    function settings() {
        const s = ctx()?.extensionSettings ?? _ext?.extension_settings ?? (window.extension_settings ??= {});
        if (!s[MY_KEY] || typeof s[MY_KEY] !== 'object') s[MY_KEY] = {};
        const m = s[MY_KEY];
        if (typeof m.enabled !== 'boolean') m.enabled = true;
        if (typeof m.onMessages !== 'boolean') m.onMessages = true;
        if (typeof m.onCharList !== 'boolean') m.onCharList = true;
        return m;
    }
    function save() { try { ctx()?.saveSettingsDebounced?.(); } catch { _ext?.saveSettingsDebounced?.(); } }
    const isEnabled = () => settings().enabled !== false;
    const characters = () => ctx()?.characters ?? _script?.characters ?? [];

    // ── IndexedDB ───────────────────────────────────────────────────────────
    const DB_NAME = 'avatar_gallery_db', DB_STORE = 'galleries';
    let _dbPromise = null;
    function db() {
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise((res, rej) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE, { keyPath: 'key' }); };
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
        });
        return _dbPromise;
    }
    async function idbGet(key) {
        const d = await db();
        return new Promise((res) => { const r = d.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
    }
    async function idbSet(record) {
        const d = await db();
        return new Promise((res) => { const tx = d.transaction(DB_STORE, 'readwrite'); tx.objectStore(DB_STORE).put(record); tx.oncomplete = () => res(true); tx.onerror = () => res(false); });
    }
    async function idbGetAll() {
        const d = await db();
        return new Promise((res) => { const r = d.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); });
    }
    async function idbDel(key) {
        const d = await db();
        return new Promise((res) => { const tx = d.transaction(DB_STORE, 'readwrite'); tx.objectStore(DB_STORE).delete(key); tx.oncomplete = () => res(true); tx.onerror = () => res(false); });
    }

    // ── Картинки ────────────────────────────────────────────────────────────
    function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('img')); i.src = src; }); }
    async function downscale(dataUrl, max = STORE_MAX) {
        try {
            const img = await loadImage(dataUrl);
            let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
            if (!w || !h) return dataUrl;
            const scale = Math.min(1, max / Math.max(w, h));
            if (scale >= 1) return dataUrl;
            const cv = document.createElement('canvas');
            cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            return cv.toDataURL('image/png');
        } catch { return dataUrl; }
    }
    function fileToDataUrl(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result || '')); r.onerror = () => rej(r.error); r.readAsDataURL(file); }); }
    async function urlToDataUrl(url) {
        try {
            const r = await fetch(url, { cache: 'no-cache' });
            if (!r.ok) return null;
            const blob = await r.blob();
            return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result || '')); fr.onerror = () => res(null); fr.readAsDataURL(blob); });
        } catch { return null; }
    }
    function dataUrlToBlob(dataUrl) {
        const [h, d] = dataUrl.split(',');
        const mime = (h.match(/:(.*?);/) || [, 'image/png'])[1];
        const bin = atob(d); const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: mime });
    }

    // ── ST helpers ──────────────────────────────────────────────────────────
    function headers() {
        try { const h = (_script?.getRequestHeaders?.({ omitContentType: true })) ?? ctx()?.getRequestHeaders?.() ?? {}; delete h['Content-Type']; return h; } catch { return {}; }
    }
    function thumb(type, id) { try { if (_script?.getThumbnailUrl) return _script.getThumbnailUrl(type, id); } catch {} return `/thumbnail?type=${type}&file=${encodeURIComponent(id)}`; }
    function bustImages(token) {
        if (!token) return;
        const enc = encodeURIComponent(token);
        document.querySelectorAll('img').forEach(img => {
            const src = img.getAttribute('src') || '';
            if (src.includes(token) || src.includes(enc)) {
                const base = src.split('#')[0].split('?')[0];
                let q = src.includes('?') ? src.slice(src.indexOf('?') + 1) : '';
                q = q.replace(/[&?]?_agb=\d+/, '');
                img.src = base + '?' + (q ? q + '&' : '') + '_agb=' + Date.now();
            }
        });
    }

    // ── Сущности ────────────────────────────────────────────────────────────
    function personaEntity(avatarId, name) {
        if (!avatarId) return null;
        let nm = name;
        try { if (!nm && _power?.power_user?.personas) nm = _power.power_user.personas[avatarId]; } catch {}
        return { type: 'persona', id: avatarId, key: 'persona:' + avatarId, name: nm || avatarId, currentSrc: thumb('persona', avatarId), fullSrc: '/User Avatars/' + encodeURIComponent(avatarId) };
    }
    function charEntityFor(avatarKey, name) {
        if (!avatarKey) return null;
        return { type: 'char', id: avatarKey, key: 'char:' + avatarKey, name: name || avatarKey, currentSrc: thumb('avatar', avatarKey), fullSrc: '/characters/' + encodeURIComponent(avatarKey) };
    }
    function charEntity() {
        const c = ctx();
        const idx = c?.characterId ?? _script?.this_chid ?? -1;
        const char = characters()?.[idx];
        return char?.avatar ? charEntityFor(char.avatar, char.name) : null;
    }
    function entityFromKey(key) {
        if (typeof key !== 'string') return null;
        if (key.startsWith('persona:')) return personaEntity(key.slice(8));
        if (key.startsWith('char:')) { const av = key.slice(5); const ch = characters()?.find?.(x => x?.avatar === av); return charEntityFor(av, ch?.name); }
        return null;
    }
    function parseAvatarFromSrc(src) {
        try {
            const u = new URL(src, location.href);
            const type = u.searchParams.get('type'), file = u.searchParams.get('file');
            if (type === 'persona' && file) return { kind: 'persona', id: decodeURIComponent(file) };
            if (type === 'avatar' && file) return { kind: 'char', id: decodeURIComponent(file) };
            const p = decodeURIComponent(u.pathname); let m;
            if ((m = p.match(/\/User Avatars\/(.+)$/))) return { kind: 'persona', id: m[1] };
            if ((m = p.match(/\/characters\/(.+)$/))) return { kind: 'char', id: m[1] };
        } catch {}
        return null;
    }
    function entityFromMessage(mes) {
        if (!mes) return null;
        const isUser = mes.getAttribute('is_user') === 'true';
        const img = mes.querySelector('.mesAvatarWrapper .avatar img, .avatar img');
        const parsed = parseAvatarFromSrc(img?.getAttribute('src') || '');
        if (parsed?.kind === 'persona') return personaEntity(parsed.id);
        if (parsed?.kind === 'char') return charEntityFor(parsed.id, mes.getAttribute('ch_name'));
        return isUser ? personaEntity(_personas?.user_avatar) : charEntity();
    }

    // ── Применение к реальной аватарке ──────────────────────────────────────
    async function applyToST(entity, dataUrl) {
        const blob = dataUrlToBlob(dataUrl);
        const fd = new FormData();
        let url;
        if (entity.type === 'persona') { fd.append('avatar', blob, 'avatar.png'); fd.append('overwrite_name', entity.id); url = '/api/avatars/upload'; }
        else { fd.append('avatar', blob, 'avatar.png'); fd.append('avatar_url', entity.id); url = '/api/characters/edit-avatar'; }
        const r = await fetch(url, { method: 'POST', headers: headers(), cache: 'no-cache', body: fd });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        try { await fetch(thumb(entity.type === 'persona' ? 'persona' : 'avatar', entity.id), { cache: 'reload' }); } catch {}
        bustImages(entity.id);
        return true;
    }

    // ── Хранилище галереи ───────────────────────────────────────────────────
    function mkImgId() { return 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
    async function getGallery(entity) {
        let rec = await idbGet(entity.key);
        if (!rec) rec = { key: entity.key, images: [], appliedId: null };
        if (!Array.isArray(rec.images)) rec.images = [];
        if (rec.images.length === 0) {
            const cur = await urlToDataUrl(entity.fullSrc) || await urlToDataUrl(entity.currentSrc);
            if (cur) { const item = { id: mkImgId(), data: await downscale(cur), ts: Date.now() }; rec.images.push(item); rec.appliedId = item.id; await idbSet(rec); }
        }
        return rec;
    }
    async function addImages(entity, dataUrls) {
        const rec = await getGallery(entity);
        let last = null;
        for (const du of dataUrls) { const item = { id: mkImgId(), data: await downscale(du), ts: Date.now() }; rec.images.push(item); last = item; }
        await idbSet(rec);
        return last;
    }
    async function removeImage(entity, imgId) {
        const rec = await getGallery(entity);
        rec.images = rec.images.filter(i => i.id !== imgId);
        if (rec.appliedId === imgId) rec.appliedId = null;
        await idbSet(rec);
        return rec;
    }
    async function markApplied(entity, imgId) { const rec = await getGallery(entity); rec.appliedId = imgId; await idbSet(rec); }

    // ── Одиночная галерея (модалка) ─────────────────────────────────────────
    let _entity = null, _rec = null, _view = 0, _busy = false;

    function buildModal() {
        if (document.getElementById('ag-modal')) return;
        document.body.insertAdjacentHTML('beforeend', `
<div id="ag-modal" role="dialog" aria-modal="true">
  <div class="ag-panel">
    <div class="ag-head">
      <div class="ag-title"><i class="fa-solid fa-images"></i> <span id="ag-name">Галерея</span></div>
      <button class="ag-close" id="ag-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="ag-sub" id="ag-sub"></div>
    <div class="ag-stage">
      <button class="ag-arrow" id="ag-prev"><i class="fa-solid fa-chevron-left"></i></button>
      <div class="ag-figure" id="ag-figure">
        <img id="ag-main" src="" alt="avatar">
        <div class="ag-ring"></div>
        <div class="ag-empty" id="ag-empty"><i class="fa-solid fa-image"></i><div>Пусто</div><small>Загрузи картинки ниже</small></div>
      </div>
      <button class="ag-arrow" id="ag-next"><i class="fa-solid fa-chevron-right"></i></button>
    </div>
    <div class="ag-bar">
      <span class="ag-counter" id="ag-counter">0 / 0</span>
      <button class="ag-apply menu_button" id="ag-apply"><i class="fa-solid fa-wand-magic-sparkles"></i> Сделать аватаркой</button>
    </div>
    <div class="ag-thumbs" id="ag-thumbs"></div>
    <div class="ag-foot">
      <button class="ag-upload menu_button" id="ag-upload"><i class="fa-solid fa-plus"></i> Загрузить картинки</button>
      <input type="file" id="ag-file" accept="image/*" multiple hidden>
    </div>
    <div class="ag-status" id="ag-status"></div>
  </div>
</div>`);
        const $ = (id) => document.getElementById(id);
        $('ag-close').onclick = closeModal;
        $('ag-modal').onclick = (e) => { if (e.target.id === 'ag-modal') closeModal(); };
        $('ag-prev').onclick = () => nav(-1);
        $('ag-next').onclick = () => nav(1);
        $('ag-apply').onclick = onApply;
        $('ag-upload').onclick = () => $('ag-file').click();
        $('ag-file').onchange = onUpload;
        document.addEventListener('keydown', (e) => {
            if (!document.getElementById('ag-modal')?.classList.contains('open')) return;
            if (e.key === 'ArrowLeft') nav(-1);
            if (e.key === 'ArrowRight') nav(1);
            if (e.key === 'Escape') closeModal();
        });
    }
    function closeModal() { document.getElementById('ag-modal')?.classList.remove('open'); }

    async function openFor(entity) {
        if (!entity) return;
        buildModal();
        _entity = entity; _view = 0;
        document.getElementById('ag-modal').classList.add('open');
        document.getElementById('ag-name').textContent = entity.name;
        document.getElementById('ag-sub').textContent = entity.type === 'persona' ? 'Персона' : 'Персонаж';
        setStatus('Загрузка…', '');
        _rec = await getGallery(entity);
        if (_rec.appliedId) { const i = _rec.images.findIndex(x => x.id === _rec.appliedId); if (i >= 0) _view = i; }
        setStatus('', '');
        render();
    }

    function render() {
        const $ = (id) => document.getElementById(id);
        const imgs = _rec?.images || [];
        const total = imgs.length;
        const main = $('ag-main'), empty = $('ag-empty'), fig = $('ag-figure'), apply = $('ag-apply');
        if (total === 0) {
            main.style.display = 'none'; empty.style.display = 'flex'; fig.classList.remove('is-applied');
            $('ag-counter').textContent = '0 / 0'; $('ag-prev').disabled = $('ag-next').disabled = true;
            apply.disabled = true; $('ag-thumbs').innerHTML = ''; return;
        }
        if (_view >= total) _view = total - 1; if (_view < 0) _view = 0;
        const cur = imgs[_view];
        const applied = cur.id === _rec.appliedId;
        main.style.display = 'block'; empty.style.display = 'none';
        main.classList.add('fade');
        setTimeout(() => { main.src = cur.data; main.classList.remove('fade'); }, 80);
        fig.classList.toggle('is-applied', applied);
        $('ag-counter').textContent = `${_view + 1} / ${total}`;
        $('ag-prev').disabled = $('ag-next').disabled = total <= 1;
        apply.disabled = applied || _busy;
        apply.innerHTML = applied ? '<i class="fa-solid fa-circle-check"></i> Текущая аватарка' : '<i class="fa-solid fa-wand-magic-sparkles"></i> Сделать аватаркой';

        const thumbs = $('ag-thumbs'); thumbs.innerHTML = '';
        imgs.forEach((im, i) => thumbs.appendChild(thumbEl(im, i === _view, im.id === _rec.appliedId,
            () => { _view = i; render(); },
            (e) => { e.stopPropagation(); onDelete(im.id); })));
        const active = thumbs.querySelector('.ag-thumb.selected'); active?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    function thumbEl(im, selected, applied, onClick, onDel) {
        const wrap = document.createElement('div');
        wrap.className = 'ag-thumb-wrap' + (applied ? ' applied' : '');
        const t = document.createElement('img');
        t.className = 'ag-thumb' + (selected ? ' selected' : '');
        t.src = im.data; t.loading = 'lazy'; t.onclick = onClick;
        const del = document.createElement('button');
        del.className = 'ag-thumb-del'; del.title = 'Удалить'; del.innerHTML = '<i class="fa-solid fa-xmark"></i>'; del.onclick = onDel;
        if (applied) { const s = document.createElement('div'); s.className = 'ag-thumb-star'; s.innerHTML = '<i class="fa-solid fa-circle-check"></i>'; wrap.appendChild(s); }
        wrap.appendChild(t); wrap.appendChild(del);
        return wrap;
    }
    function nav(d) { const total = _rec?.images?.length || 0; if (!total) return; _view = (_view + d + total) % total; render(); }
    function setStatus(text, kind) {
        const el = document.getElementById('ag-status'); if (!el) return;
        el.textContent = text; el.className = 'ag-status ' + (kind || '');
        if (kind === 'ok' || kind === 'warn') { clearTimeout(setStatus._t); setStatus._t = setTimeout(() => { el.textContent = ''; el.className = 'ag-status'; }, 3500); }
    }
    async function onUpload(e) {
        const files = Array.from(e.target.files || []); e.target.value = '';
        if (!files.length || !_entity) return;
        setStatus('Добавляю…', '');
        const dataUrls = [];
        for (const f of files) { try { dataUrls.push(await fileToDataUrl(f)); } catch {} }
        const last = await addImages(_entity, dataUrls);
        _rec = await getGallery(_entity);
        if (last) { const i = _rec.images.findIndex(x => x.id === last.id); if (i >= 0) _view = i; }
        render(); setStatus('✓ Добавлено', 'ok');
    }
    async function onDelete(imgId) {
        if (!_entity) return;
        _rec = await removeImage(_entity, imgId);
        if (_view >= _rec.images.length) _view = Math.max(0, _rec.images.length - 1);
        render();
    }
    async function onApply() {
        if (!_entity || _busy) return;
        const cur = _rec?.images?.[_view]; if (!cur) return;
        _busy = true; render(); setStatus('Применяю…', '');
        try { await applyToST(_entity, cur.data); await markApplied(_entity, cur.id); _rec = await getGallery(_entity); setStatus('✓ Аватарка обновлена', 'ok'); }
        catch (err) { console.error('[AvatarGallery] apply', err); setStatus('⚠ Не удалось применить (' + (err?.message || 'ошибка') + ')', 'warn'); }
        finally { _busy = false; render(); }
    }

    // ── Менеджер всех аватарок ──────────────────────────────────────────────
    function buildManager() {
        if (document.getElementById('agm-modal')) return;
        document.body.insertAdjacentHTML('beforeend', `
<div id="agm-modal" role="dialog" aria-modal="true">
  <div class="ag-panel agm-panel">
    <div class="ag-head">
      <div class="ag-title"><i class="fa-solid fa-layer-group"></i> <span>Менеджер аватарок</span></div>
      <button class="ag-close" id="agm-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="agm-list" id="agm-list"></div>
    <div class="ag-status" id="agm-status"></div>
  </div>
</div>`);
        document.getElementById('agm-close').onclick = () => document.getElementById('agm-modal').classList.remove('open');
        document.getElementById('agm-modal').onclick = (e) => { if (e.target.id === 'agm-modal') e.currentTarget.classList.remove('open'); };
    }
    async function openManager() {
        buildManager();
        document.getElementById('agm-modal').classList.add('open');
        await renderManager();
    }
    function mgrStatus(text, kind) {
        const el = document.getElementById('agm-status'); if (!el) return;
        el.textContent = text; el.className = 'ag-status ' + (kind || '');
        if (kind) { clearTimeout(mgrStatus._t); mgrStatus._t = setTimeout(() => { el.textContent = ''; el.className = 'ag-status'; }, 3000); }
    }
    async function renderManager() {
        const list = document.getElementById('agm-list'); if (!list) return;
        const recs = (await idbGetAll()).filter(r => Array.isArray(r.images) && r.images.length);
        list.innerHTML = '';
        if (!recs.length) { list.innerHTML = '<div class="agm-empty"><i class="fa-solid fa-folder-open"></i><div>Пока нет сохранённых аватарок</div><small>Открой галерею на любой аватарке и добавь картинки</small></div>'; return; }
        recs.sort((a, b) => a.key.localeCompare(b.key));
        for (const rec of recs) {
            const ent = entityFromKey(rec.key);
            const name = ent?.name || rec.key;
            const isPersona = rec.key.startsWith('persona:');
            const sec = document.createElement('div'); sec.className = 'agm-entity';
            const head = document.createElement('div'); head.className = 'agm-entity-head';
            head.innerHTML = `<i class="fa-solid ${isPersona ? 'fa-id-badge' : 'fa-user'}"></i>
                <span class="agm-entity-name" title="Открыть галерею">${escapeHtml(name)}</span>
                <span class="agm-entity-cnt">${rec.images.length}</span>`;
            const delAll = document.createElement('button');
            delAll.className = 'agm-entity-del'; delAll.title = 'Удалить всю галерею этой аватарки';
            delAll.innerHTML = '<i class="fa-solid fa-trash"></i>';
            delAll.onclick = async (e) => { e.stopPropagation(); if (confirm(`Удалить все ${rec.images.length} картинок для «${name}»?`)) { await idbDel(rec.key); renderManager(); } };
            head.appendChild(delAll);
            head.querySelector('.agm-entity-name').onclick = () => { if (ent) { document.getElementById('agm-modal').classList.remove('open'); openFor(ent); } };
            sec.appendChild(head);

            const strip = document.createElement('div'); strip.className = 'ag-thumbs agm-strip';
            rec.images.forEach((im) => strip.appendChild(thumbEl(im, false, im.id === rec.appliedId,
                () => mgrApply(rec.key, im.id),
                (e) => { e.stopPropagation(); mgrDelImg(rec.key, im.id); })));
            sec.appendChild(strip);
            list.appendChild(sec);
        }
    }
    async function mgrApply(key, imgId) {
        const ent = entityFromKey(key); const rec = await idbGet(key);
        const im = rec?.images?.find(i => i.id === imgId);
        if (!ent || !im) return;
        mgrStatus('Применяю…', 'wait');
        try { await applyToST(ent, im.data); rec.appliedId = imgId; await idbSet(rec); await renderManager(); mgrStatus('✓ «' + ent.name + '» обновлена', 'ok'); }
        catch (err) { mgrStatus('⚠ Ошибка: ' + (err?.message || ''), 'warn'); }
    }
    async function mgrDelImg(key, imgId) {
        const rec = await idbGet(key); if (!rec) return;
        rec.images = rec.images.filter(i => i.id !== imgId);
        if (rec.appliedId === imgId) rec.appliedId = null;
        if (rec.images.length) await idbSet(rec); else await idbDel(key);
        renderManager();
    }
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    // ── Значки-оверлеи ──────────────────────────────────────────────────────
    function makeBtn(onClick, variant) {
        const b = document.createElement('div');
        b.className = 'ag-ov' + (variant ? ' ' + variant : '');
        b.title = 'Галерея аватарок';
        b.innerHTML = '<i class="fa-solid fa-images"></i>';
        b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
        return b;
    }
    function attachOverlay(av, onClick, variant) {
        if (!av || av.querySelector(':scope > .ag-ov')) return;
        av.style.position = 'relative';
        av.appendChild(makeBtn(onClick, variant));
    }
    function attachPersonaOverlays() {
        document.querySelectorAll('#user_avatar_block .avatar-container[data-avatar-id]').forEach(cont => {
            const av = cont.querySelector('.avatar') || cont;
            attachOverlay(av, () => {
                const id = cont.getAttribute('data-avatar-id');
                const name = cont.querySelector('.ch_name')?.textContent?.trim();
                if (id) openFor(personaEntity(id, name));
            });
        });
    }
    function attachCharOverlay() {
        const host = document.getElementById('avatar_div_div');
        attachOverlay(host, () => { const e = charEntity(); if (e) openFor(e); });
    }
    function attachMessageOverlays() {
        if (!settings().onMessages) return;
        document.querySelectorAll('#chat .mes .mesAvatarWrapper .avatar').forEach(av => {
            const mes = av.closest('.mes');
            attachOverlay(av, () => { const e = entityFromMessage(mes); if (e) openFor(e); }, 'hoveronly');
        });
    }
    function attachCharListOverlays() {
        if (!settings().onCharList) return;
        document.querySelectorAll('#rm_print_characters_block .character_select[chid] .avatar').forEach(av => {
            const sel = av.closest('.character_select');
            attachOverlay(av, () => {
                const chid = sel?.getAttribute('chid');
                if (chid === '' || chid == null) return;
                const ch = characters()?.[Number(chid)];
                if (ch?.avatar) openFor(charEntityFor(ch.avatar, ch.name));
            }, 'hoveronly');
        });
    }
    function removeOverlays(sel) { document.querySelectorAll(sel || '.ag-ov').forEach(el => el.remove()); }

    // ── Меню-палочка ────────────────────────────────────────────────────────
    function addWandEntry() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || document.getElementById('ag-wand')) return;
        const item = document.createElement('div');
        item.id = 'ag-wand';
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.innerHTML = '<div class="fa-solid fa-images extensionsMenuExtensionButton"></div><span>Менеджер аватарок</span>';
        item.onclick = openManager;
        menu.appendChild(item);
    }
    function removeWandEntry() { document.getElementById('ag-wand')?.remove(); }

    // ── Настройки ───────────────────────────────────────────────────────────
    function addSettingsPanel() {
        const root = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
        if (!root || document.getElementById('ag-settings')) return;
        root.insertAdjacentHTML('beforeend', `
<div id="ag-settings" class="inline-drawer">
  <div class="inline-drawer-header" id="ag-drawer-head" style="cursor:pointer">
    <b><i class="fa-solid fa-images"></i> Галерея аватарок</b>
    <div id="ag-drawer-icon" class="inline-drawer-icon fa-solid fa-circle-chevron-up up"></div>
  </div>
  <div class="inline-drawer-content" id="ag-drawer-body" style="display:block">
    <label class="checkbox_label"><input type="checkbox" id="ag-enabled"><span>Включить галерею (значки 🖼 на аватарках)</span></label>
    <label class="checkbox_label"><input type="checkbox" id="ag-on-messages"><span>Значки на аватарках в сообщениях чата</span></label>
    <label class="checkbox_label"><input type="checkbox" id="ag-on-charlist"><span>Значки в списке персонажей</span></label>
    <small class="ag-hint">Клик по значку открывает галерею этой аватарки; выбор делает картинку реальной аватаркой в таверне. В меню-палочке — «Менеджер аватарок» со всеми. Хранение локальное (IndexedDB).</small>
  </div>
</div>`);
        const body = document.getElementById('ag-drawer-body');
        const icon = document.getElementById('ag-drawer-icon');
        document.getElementById('ag-drawer-head').onclick = () => {
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : 'block';
            icon.classList.toggle('up', !open); icon.classList.toggle('down', open);
        };
        const en = document.getElementById('ag-enabled');
        const msg = document.getElementById('ag-on-messages');
        const cl = document.getElementById('ag-on-charlist');
        en.checked = isEnabled(); msg.checked = settings().onMessages !== false; cl.checked = settings().onCharList !== false;
        en.onchange = () => { settings().enabled = en.checked; save(); applyEnabledState(); };
        msg.onchange = () => { settings().onMessages = msg.checked; save(); removeOverlays('.ag-ov.hoveronly'); tick(); };
        cl.onchange = () => { settings().onCharList = cl.checked; save(); removeOverlays('.ag-ov.hoveronly'); tick(); };
    }
    function applyEnabledState() {
        if (isEnabled()) { tick(); }
        else { removeOverlays(); removeWandEntry(); closeModal(); document.getElementById('agm-modal')?.classList.remove('open'); }
    }

    // ── Init ────────────────────────────────────────────────────────────────
    buildModal();
    function tick() {
        if (!isEnabled()) return;
        attachPersonaOverlays();
        attachCharOverlay();
        attachMessageOverlays();
        attachCharListOverlays();
        addWandEntry();
    }
    function initOnce() { addSettingsPanel(); applyEnabledState(); }
    [200, 700, 1500, 3000].forEach(t => setTimeout(initOnce, t));

    try {
        const ev = _script?.eventSource ?? ctx()?.eventSource;
        const et = _script?.event_types ?? ctx()?.eventTypes ?? ctx()?.event_types;
        if (ev && et) {
            const on = () => setTimeout(tick, 250);
            [et.CHAT_CHANGED, et.CHARACTER_SELECTED, et.PERSONA_CHANGED, et.SETTINGS_UPDATED, et.MESSAGE_RECEIVED, et.USER_MESSAGE_RENDERED, et.CHARACTER_MESSAGE_RENDERED].forEach(e => { if (e) try { ev.on(e, on); } catch {} });
        }
    } catch {}

    let dbt;
    const obs = new MutationObserver(() => { if (!isEnabled()) return; clearTimeout(dbt); dbt = setTimeout(tick, 200); });
    const observe = (id, opts) => { const el = document.getElementById(id); if (el) obs.observe(el, opts); };
    const startObs = () => {
        observe('user_avatar_block', { childList: true, subtree: true });
        observe('extensionsMenu', { childList: true });
        observe('chat', { childList: true });
        observe('rm_print_characters_block', { childList: true, subtree: true });
    };
    [500, 2000].forEach(t => setTimeout(startObs, t));

    window.AvatarGallery = { open: openFor, openManager, personaEntity, charEntity, charEntityFor };
    console.log('[AvatarGallery] ready ✓ (real ST avatar swap + manager)');
})();
