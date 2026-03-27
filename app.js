const SCRYFALL = "https://api.scryfall.com";
const DELAY_MS = 100;

const form = document.getElementById("deck-form");
const input = document.getElementById("commander-input");
const btn = document.getElementById("generate-btn");
const btnText = btn.querySelector(".btn-text");
const btnLoading = btn.querySelector(".btn-loading");
const errorMsg = document.getElementById("error-msg");
const resultEl = document.getElementById("deck-result");
const loadingEl = document.getElementById("loading");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function scryfallFetch(path) {
  await sleep(DELAY_MS);
  const res = await fetch(`${SCRYFALL}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.details || `Scryfall error: ${res.status}`);
  }
  return res.json();
}

async function fetchCards(query, maxCards) {
  const cards = [];
  let page = 1;
  while (cards.length < maxCards) {
    const data = await scryfallFetch(
      `/cards/search?q=${encodeURIComponent(query)}&order=edhrec&unique=cards&page=${page}`
    );
    for (const card of data.data) {
      if (cards.length >= maxCards) break;
      if (card.prices?.usd || card.prices?.usd_foil) {
        cards.push(card);
      }
    }
    if (!data.has_more) break;
    page++;
    if (page > 3) break;
  }
  return cards;
}

function getImageUri(card) {
  if (card.image_uris?.normal) return card.image_uris.normal;
  if (card.card_faces?.[0]?.image_uris?.normal)
    return card.card_faces[0].image_uris.normal;
  return null;
}

function formatCard(card) {
  const price = card.prices?.usd || card.prices?.usd_foil || "0.00";
  return {
    name: card.name,
    quantity: 1,
    price: `$${price}`,
    reason: card.type_line || "Unknown type",
    image: getImageUri(card),
    scryfall_uri: card.scryfall_uri,
    mana_cost: card.mana_cost || "",
    cmc: card.cmc || 0,
  };
}

function getBasicLands(colorIdentity) {
  const map = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };
  if (colorIdentity.length === 0) return ["Wastes"];
  return colorIdentity.map((c) => map[c]).filter(Boolean);
}

async function lookupCommander(name) {
  // Try fuzzy match first
  try {
    return await scryfallFetch(`/cards/named?fuzzy=${encodeURIComponent(name.trim())}`);
  } catch {
    // Fall back to search for legendary creatures
    try {
      const search = await scryfallFetch(
        `/cards/search?q=${encodeURIComponent(name.trim())}+t%3Alegendary+t%3Acreature+f%3Acommander&order=edhrec`
      );
      if (search.data && search.data.length > 0) return search.data[0];
    } catch {
      // Search also failed
    }
    throw new Error(`Could not find a commander matching "${name}". Try a more complete name like "Krenko, Mob Boss".`);
  }
}

function validateCommander(commander) {
  const typeLine = commander.type_line || "";
  const oracleText = commander.oracle_text || "";
  const isLegendaryCreature = typeLine.includes("Legendary") && typeLine.includes("Creature");
  const canBeCommander = oracleText.includes("can be your commander");
  const isLegendaryPlaneswalker = typeLine.includes("Legendary") && typeLine.includes("Planeswalker");

  if (!isLegendaryCreature && !canBeCommander && !isLegendaryPlaneswalker) {
    throw new Error(`"${commander.name}" is not a valid commander. It must be a legendary creature.`);
  }
  if (commander.legalities?.commander === "banned") {
    throw new Error(`"${commander.name}" is banned in Commander.`);
  }
}

async function buildDeck(commander) {
  const ci = commander.color_identity;
  const colorStr = ci.length > 0 ? ci.join("").toLowerCase() : "c";
  const commanderName = commander.name;

  const base = `f:commander id<=${colorStr}`;
  const budget = "usd<3";

  const slots = [
    { name: "Creatures", query: `${base} ${budget} t:creature`, count: 25 },
    { name: "Instants", query: `${base} ${budget} t:instant`, count: 8 },
    { name: "Sorceries", query: `${base} ${budget} t:sorcery`, count: 8 },
    { name: "Enchantments", query: `${base} ${budget} t:enchantment -t:creature`, count: 6 },
    { name: "Artifacts", query: `${base} ${budget} t:artifact -t:creature`, count: 8 },
    { name: "Mana Rocks & Ramp", query: `${base} ${budget} (t:artifact o:add o:mana) or (${base} ${budget} t:creature o:"search your library" o:land)`, count: 6 },
  ];

  const categories = [];
  const usedNames = new Set([commanderName]);
  let nonlandTotal = 1;

  for (const slot of slots) {
    try {
      const fetched = await fetchCards(slot.query, slot.count * 3);
      const picked = [];
      for (const card of fetched) {
        if (picked.length >= slot.count) break;
        if (usedNames.has(card.name)) continue;
        if (card.type_line?.includes("Basic Land")) continue;
        usedNames.add(card.name);
        picked.push(formatCard(card));
      }
      if (picked.length > 0) {
        categories.push({ name: slot.name, cards: picked });
        nonlandTotal += picked.length;
      }
    } catch {
      // Skip failed category
    }
  }

  const landsNeeded = 100 - nonlandTotal;
  const landCards = [];

  try {
    const nonbasics = await fetchCards(`${base} ${budget} t:land -t:basic`, Math.min(landsNeeded, 20));
    for (const card of nonbasics) {
      if (landCards.length >= landsNeeded - 5) break;
      if (usedNames.has(card.name)) continue;
      usedNames.add(card.name);
      landCards.push(formatCard(card));
    }
  } catch {
    // Use more basics
  }

  const basicsNeeded = landsNeeded - landCards.length;
  if (basicsNeeded > 0) {
    const basicTypes = getBasicLands(ci);
    const perBasic = Math.floor(basicsNeeded / basicTypes.length);
    const remainder = basicsNeeded % basicTypes.length;
    for (let i = 0; i < basicTypes.length; i++) {
      const qty = perBasic + (i < remainder ? 1 : 0);
      if (qty > 0) {
        landCards.push({
          name: basicTypes[i],
          quantity: qty,
          price: "$0.10",
          reason: "Basic Land",
        });
      }
    }
  }

  categories.push({ name: "Lands", cards: landCards });

  let totalCards = 1;
  let totalPrice = parseFloat(commander.prices?.usd || "0");
  for (const cat of categories) {
    for (const card of cat.cards) {
      totalCards += card.quantity;
      totalPrice += parseFloat(card.price.replace("$", "")) * card.quantity;
    }
  }

  return {
    commander: commanderName,
    commander_image: getImageUri(commander),
    color_identity: ci.join("") || "C",
    strategy: `A budget Commander deck built around ${commanderName}, using the most popular EDH staples within its color identity. Cards sorted by EDHREC popularity to maximize synergy and power on a budget.`,
    estimated_budget: `$${totalPrice.toFixed(0)}`,
    total_cards: totalCards,
    categories,
  };
}

// --- Form handler ---
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = input.value.trim();
  if (!name) return;

  btn.disabled = true;
  btnText.hidden = true;
  btnLoading.hidden = false;
  errorMsg.hidden = true;
  resultEl.hidden = true;
  loadingEl.classList.add("active");

  try {
    const commander = await lookupCommander(name);
    validateCommander(commander);
    const deck = await buildDeck(commander);
    renderDeck(deck);
  } catch (err) {
    errorMsg.textContent = err.message;
    errorMsg.hidden = false;
  } finally {
    btn.disabled = false;
    btnText.hidden = false;
    btnLoading.hidden = true;
    loadingEl.classList.remove("active");
  }
});

// --- Rendering ---
function renderDeck(deck) {
  const imgEl = document.getElementById("commander-img");
  if (deck.commander_image) {
    imgEl.src = deck.commander_image;
    imgEl.alt = deck.commander;
    imgEl.hidden = false;
  } else {
    imgEl.hidden = true;
  }

  document.getElementById("deck-commander").textContent = deck.commander;
  document.getElementById("deck-count").textContent = deck.total_cards;
  document.getElementById("deck-budget").textContent = deck.estimated_budget;
  document.getElementById("deck-strategy").textContent = deck.strategy;

  const colorMap = { W: "W", U: "U", B: "B", R: "R", G: "G", C: "C" };
  const pipsEl = document.getElementById("deck-colors");
  pipsEl.innerHTML = "";
  for (const char of deck.color_identity.toUpperCase()) {
    if (colorMap[char]) {
      const pip = document.createElement("span");
      pip.className = `pip pip-${char}`;
      pip.textContent = char;
      pipsEl.appendChild(pip);
    }
  }

  const container = document.getElementById("deck-categories");
  container.innerHTML = "";

  for (const cat of deck.categories) {
    const section = document.createElement("div");
    section.className = "category";

    const catTotal = cat.cards.reduce((sum, c) => sum + (c.quantity || 1), 0);

    const header = document.createElement("div");
    header.className = "category-header";
    header.innerHTML = `
      <span class="category-name">${esc(cat.name)}</span>
      <span class="category-count">${catTotal}</span>
    `;
    header.addEventListener("click", () => section.classList.toggle("collapsed"));

    const cardsDiv = document.createElement("div");
    cardsDiv.className = "category-cards";

    for (const card of cat.cards) {
      const qty = card.quantity || 1;
      const scryfallLink = card.scryfall_uri || `https://scryfall.com/search?q=${encodeURIComponent(card.name)}`;
      const row = document.createElement("div");
      row.className = "card-row";

      let previewHtml = "";
      if (card.image) {
        previewHtml = `<div class="card-preview"><img src="${esc(card.image)}" alt="${esc(card.name)}" loading="lazy" /></div>`;
      }

      row.innerHTML = `
        <div>
          <div class="card-name-wrap">
            ${qty > 1 ? `<span class="card-qty">${qty}x</span>` : ""}
            <span class="card-name"><a href="${esc(scryfallLink)}" target="_blank" rel="noopener">${esc(card.name)}</a></span>
          </div>
          <div class="card-type">${esc(card.reason)}</div>
        </div>
        <div class="card-mana">${formatMana(card.mana_cost || "")}</div>
        <div class="card-price">${esc(card.price)}</div>
        ${previewHtml}
      `;
      cardsDiv.appendChild(row);
    }

    section.appendChild(header);
    section.appendChild(cardsDiv);
    container.appendChild(section);
  }

  resultEl.hidden = false;
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function formatMana(manaCost) {
  if (!manaCost) return "";
  return manaCost.replace(/\{([^}]+)\}/g, (_, symbol) => {
    return `<span class="mana-sym">${esc(symbol)}</span>`;
  });
}

function esc(str) {
  if (!str) return "";
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}
