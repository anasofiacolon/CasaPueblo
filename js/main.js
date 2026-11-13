// Public site: mobile menu + screens rendered from the API.
// Every value shown here comes from the public serializer, which already
// removed anything the community chose not to publish.
(function () {
  document.querySelector('.menu-button')?.addEventListener('click', () => document.querySelector('.nav-links')?.classList.toggle('mobile-open'));

  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);
  const plain = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  async function api(path, options) {
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'No se pudo completar la solicitud.'), { status: res.status });
    return data;
  }

  const displayName = (c) => c.name || 'Comunidad (nombre reservado)';
  const displayPlace = (c) => c.location_text || c.country || c.region || '';
  const profileUrl = (c) => `comunidad.html?slug=${encodeURIComponent(c.slug)}`;
  // Only http(s) links are rendered as links.
  const safeUrl = (url) => (/^https?:\/\//i.test(url || '') ? url : null);

  function communityCard(c, linkText) {
    const place = displayPlace(c);
    return `<article class="community-card">
      <div class="community-image">Imagen de comunidad</div>
      <div class="community-content">
        ${place ? `<p class="location">📍 ${esc(place)}</p>` : ''}
        <h3>${esc(displayName(c))}</h3>
        <p>${esc(c.description || '')}</p><a href="${profileUrl(c)}">${linkText} →</a>
      </div>
    </article>`;
  }

  const message = (text) => `<p class="empty-state">${esc(text)}</p>`;
  let communitiesPromise;
  const loadCommunities = () => (communitiesPromise ??= api('/api/communities').then((d) => d.communities));

  // ---------- index.html: featured communities ----------
  async function featured(grid) {
    try {
      const list = await loadCommunities();
      grid.innerHTML = list.length ? list.slice(0, 3).map((c) => communityCard(c, 'Conocer la comunidad')).join('') : message('Pronto compartiremos las primeras comunidades.');
    } catch {
      grid.innerHTML = message('No pudimos cargar las comunidades. Intenta de nuevo más tarde.');
    }
  }

  // ---------- comunidades.html: full list + filters ----------
  async function directory(grid) {
    let list = [];
    const render = (keyword) => {
      const shown = keyword ? list.filter((c) => plain([c.tags.join(' '), c.description, c.energy_initiative_details].join(' ')).includes(keyword)) : list;
      grid.innerHTML = shown.length ? shown.map((c) => communityCard(c, 'Ver perfil')).join('') : message('No hay comunidades publicadas en esta categoría.');
    };
    try {
      list = await loadCommunities();
      render('');
    } catch {
      grid.innerHTML = message('No pudimos cargar las comunidades. Intenta de nuevo más tarde.');
      return;
    }
    // "Todas" has no keyword; the other buttons match their label against tags and descriptions.
    const keywords = { todas: '', solar: 'solar', microredes: 'microred', 'autonomia energetica': 'autonom' };
    document.querySelectorAll('.filters .filter').forEach((button) =>
      button.addEventListener('click', () => {
        document.querySelectorAll('.filters .filter').forEach((b) => b.classList.toggle('active', b === button));
        const label = plain(button.textContent.trim());
        render(keywords[label] ?? label);
      }),
    );
  }

  // ---------- comunidad.html: profile ----------
  async function profile(root) {
    const slug = new URLSearchParams(location.search).get('slug');
    const title = $('h1', root);
    if (!slug) {
      location.replace('comunidades.html');
      return;
    }
    let c;
    try {
      c = (await api(`/api/communities/${encodeURIComponent(slug)}`)).community;
    } catch (err) {
      title.textContent = err.status === 404 ? 'Comunidad no encontrada' : 'No pudimos cargar la comunidad';
      $('[data-profile="description"]').textContent = 'Regresa al listado para explorar las comunidades publicadas.';
      $('[data-profile="meta"]').innerHTML = '';
      $('[data-profile="map-link"]').hidden = true;
      $('[data-profile="details"]').hidden = true;
      return;
    }
    document.title = `${displayName(c)} | Casa Pueblo`;
    title.textContent = displayName(c);
    const place = displayPlace(c);
    $('[data-profile="meta"]').innerHTML = [place ? `📍 ${esc(place)}` : '', ...c.tags.map((t) => `☀ ${esc(t)}`)].filter(Boolean).map((t) => `<span>${t}</span>`).join('');
    $('[data-profile="description"]').textContent = c.description || '';
    const mapLink = $('[data-profile="map-link"]');
    if (c.latitude !== null) mapLink.href = `mapa.html?slug=${encodeURIComponent(c.slug)}`;
    else mapLink.hidden = true;

    const links = [];
    const web = safeUrl(c.website_url);
    if (web) links.push(`<p><strong>Sitio web:</strong> <a href="${esc(web)}" rel="noopener noreferrer" target="_blank">${esc(web)}</a></p>`);
    if (c.contact_email) links.push(`<p><strong>Contacto:</strong> <a href="mailto:${esc(c.contact_email)}">${esc(c.contact_email)}</a></p>`);
    const more = $('[data-profile="more"]');
    if (links.length) more.innerHTML = links.join('');
    else more.closest('.content-block').hidden = true;

    $('[data-profile="initiative"]').textContent = c.energy_initiative_details || 'La comunidad no ha publicado detalles de su iniciativa.';
    $('[data-profile="location"]').textContent =
      [c.location_text, c.country].filter((v, i, a) => v && a.indexOf(v) === i).join(' · ') || 'La comunidad no ha autorizado la publicación de su ubicación.';
  }

  // ---------- mapa.html: Leaflet + OpenStreetMap ----------
  async function map(container) {
    const listEl = $('.map-list');
    let list;
    try {
      list = await loadCommunities();
    } catch {
      listEl.innerHTML = message('No pudimos cargar las comunidades.');
      return;
    }
    // Only communities that authorized a public location carry coordinates.
    const located = list.filter((c) => c.latitude !== null && c.longitude !== null);
    listEl.innerHTML = located.length
      ? located.map((c, i) => `<article class="card" data-index="${i}"><h3>${esc(displayName(c))}</h3><p>📍 ${esc(displayPlace(c))}</p><button class="link" type="button">Ver en el mapa</button><a href="${profileUrl(c)}">Ver perfil →</a></article>`).join('')
      : message('Aún no hay comunidades con ubicación pública.');

    if (typeof L === 'undefined') {
      container.textContent = 'No se pudo cargar el mapa.';
      return;
    }
    container.textContent = '';
    const leaflet = L.map(container, { scrollWheelZoom: false }).setView([15, -78], 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(leaflet);

    const markers = located.map((c) => {
      const popup = document.createElement('div');
      popup.innerHTML = `<strong>${esc(displayName(c))}</strong><br>${esc(displayPlace(c))}<br><a href="${profileUrl(c)}">Ver perfil →</a>`;
      return L.marker([c.latitude, c.longitude]).addTo(leaflet).bindPopup(popup);
    });
    const focus = (i) => {
      leaflet.setView(markers[i].getLatLng(), 11);
      markers[i].openPopup();
      listEl.querySelectorAll('.card').forEach((card) => card.classList.toggle('active', Number(card.dataset.index) === i));
    };
    listEl.addEventListener('click', (event) => {
      const card = event.target.closest('button.link')?.closest('.card');
      if (card) focus(Number(card.dataset.index));
    });
    if (markers.length > 1) leaflet.fitBounds(L.featureGroup(markers).getBounds().pad(0.3));
    else if (markers.length === 1) leaflet.setView(markers[0].getLatLng(), 9);

    const wanted = new URLSearchParams(location.search).get('slug');
    const index = located.findIndex((c) => c.slug === wanted);
    if (index >= 0) focus(index);
  }

  // ---------- participar.html: public submission ----------
  function submissionForm(form) {
    const status = $('#formMessage');
    const button = $('button[type="submit"]', form);
    const value = (id) => $(`#${id}`, form).value.trim();
    const checked = (id) => $(`#${id}`, form).checked;
    const show = (kind, text) => {
      status.className = `form-message ${kind}`;
      status.textContent = text;
      status.hidden = false;
      status.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      try {
        await api('/api/submissions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            community_name: value('name'),
            location_text: value('location') || null, // optional: blank is stored as NULL
            description: value('description'),
            energy_initiative_details: value('initiative'),
            submitter_email: value('contact'),
            submitter_comments: value('comments') || null,
            show_community_name: checked('show_community_name'),
            show_location: checked('show_location'),
            show_description: checked('show_description'),
            show_energy_initiative_details: checked('show_energy_initiative_details'),
            show_submitter_email: checked('show_submitter_email'),
          }),
        });
        form.reset();
        show('success', '¡Gracias! Recibimos la información. Un administrador la revisará antes de publicarla.');
      } catch (err) {
        show('error', err.message);
      } finally {
        button.disabled = false;
      }
    });
  }

  // ---------- proyecto.html: project information from the database ----------
  // The static HTML is the fallback; sections are replaced only when the API answers.
  async function projectInfo() {
    let sections;
    try {
      sections = (await api('/api/project-info')).sections;
    } catch {
      return;
    }
    for (const s of sections) {
      const el = $(`[data-section-key="${s.section_key}"]`);
      if (!el) continue;
      let content;
      try {
        content = JSON.parse(s.content);
      } catch {
        content = { paragraphs: String(s.content).split(/\n{2,}/) };
      }
      const paragraphs = (content.paragraphs || []).map((p) => `<p>${esc(p)}</p>`).join('');
      const eyebrow = content.eyebrow ? `<p class="eyebrow">${esc(content.eyebrow)}</p>` : '';
      const heading = `<h2>${esc(s.title)}</h2>`;
      const cards = content.items?.length
        ? `<div class="project-grid">${content.items.map((i) => `<article class="card"><h3>${esc(i.title)}</h3><p>${esc(i.text)}</p></article>`).join('')}</div>`
        : '';
      const note = content.note ? `<p class="project-note">${esc(content.note)}</p>` : '';
      const list = content.list?.length
        ? `${content.list_title ? `<h3 class="project-subheading">${esc(content.list_title)}</h3>` : ''}<ul class="dimension-list">${content.list.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
        : '';
      // Same two layouts the static page uses: a text block, or heading + cards.
      el.innerHTML = cards
        ? `${eyebrow}${heading}${el.dataset.noteFirst !== undefined ? note + cards : cards + note}${paragraphs}${list}`
        : `<div class="content-block">${eyebrow}${heading}${paragraphs}</div>${note}${list}`;
    }
  }

  const hooks = {
    '[data-communities="featured"]': featured,
    '[data-communities="all"]': directory,
    '[data-profile="root"]': profile,
    '#communityMap': map,
    '#submissionForm': submissionForm,
    '[data-section-key]': projectInfo,
  };
  for (const [selector, init] of Object.entries(hooks)) {
    const el = $(selector);
    if (el) init(el);
  }
})();
