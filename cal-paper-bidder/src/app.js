const REQUIRED_COLUMNS = ["paper", "title", "preference", "abstract", "topics"];

const state = {
  papers: [],
  topicRatings: new Map(),
  settings: {
    preferenceMin: -20,
    preferenceNeutral: 0,
    preferenceMax: 20,
  },
  modelWeight: 0,
  recommendedModelWeight: 0,
  modelWeightManual: false,
  rankingDirty: false,
  exportDirty: false,
  topicsDirty: false,
  lastLabelStats: { positive: 0, negative: 0, unranked: 0, balanced: 0 },
  lastRankReason: "topic_only",
};

const els = {
  file: document.querySelector("#csv-file"),
  topicFile: document.querySelector("#topic-file"),
  loadExample: document.querySelector("#load-example"),
  exportCsv: document.querySelector("#export-csv"),
  saveTopics: document.querySelector("#save-topics"),
  rerank: document.querySelector("#rerank"),
  prefMin: document.querySelector("#pref-min"),
  prefNeutral: document.querySelector("#pref-neutral"),
  prefMax: document.querySelector("#pref-max"),
  modelWeight: document.querySelector("#model-weight"),
  modelWeightValue: document.querySelector("#model-weight-value"),
  modelWeightReset: document.querySelector("#model-weight-reset"),
  modelWeightLabel: document.querySelector("#model-weight-label"),
  emptyState: document.querySelector("#empty-state"),
  workspace: document.querySelector("#workspace"),
  topics: document.querySelector("#topics"),
  topicCount: document.querySelector("#topic-count"),
  papers: document.querySelector("#papers"),
  paperCount: document.querySelector("#paper-count"),
  rankSummary: document.querySelector("#rank-summary"),
  hideRated: document.querySelector("#hide-rated"),
};

els.file.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!confirmDiscardUnsavedChanges("load a new CSV")) {
    event.target.value = "";
    return;
  }
  await loadCsvText(await file.text(), file.name);
  event.target.value = "";
});

els.loadExample.addEventListener("click", async () => {
  if (!confirmDiscardUnsavedChanges("load the demo CSV")) return;
  const response = await fetch("examples/example-revprefs.csv");
  if (!response.ok) {
    alert("Could not load the example CSV. Try running a local web server.");
    return;
  }
  await loadCsvText(await response.text(), "example-revprefs.csv");
});

els.topicFile.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!confirmDiscardTopicChanges("load topic scores")) {
    event.target.value = "";
    return;
  }
  await loadTopicScores(await file.text());
  event.target.value = "";
});

els.saveTopics.addEventListener("click", () => {
  const payload = {
    format: "cal-paper-bidder-topic-scores",
    version: 1,
    topics: Object.fromEntries([...state.topicRatings.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };
  downloadText("topic-scores.json", JSON.stringify(payload, null, 2) + "\n", "application/json");
  state.topicsDirty = false;
  updateTopicSaveState();
});

els.exportCsv.addEventListener("click", () => {
  const csv = serializeCsv(
    REQUIRED_COLUMNS,
    state.papers.map((paper) => ({
      paper: paper.paper,
      title: paper.title,
      preference: String(paper.preference),
      abstract: paper.abstract,
      topics: paper.topics.join("; "),
    })),
  );
  downloadText("revprefs-updated.csv", csv, "text/csv");
  state.exportDirty = false;
  updateExportState();
});

els.rerank.addEventListener("click", () => {
  readSettings();
  rerankPapers();
  state.rankingDirty = false;
  renderPapers();
  updateRerankState();
});

els.hideRated.addEventListener("change", renderPapers);

els.modelWeight.addEventListener("input", () => {
  state.modelWeightManual = true;
  state.modelWeight = Number(els.modelWeight.value) / 100;
  updateModelWeightControls();
  markRankingDirty();
});

els.modelWeightReset.addEventListener("click", () => {
  state.modelWeightManual = false;
  state.modelWeight = state.recommendedModelWeight;
  updateModelWeightControls();
  markRankingDirty();
});

for (const input of [els.prefMin, els.prefNeutral, els.prefMax]) {
  input.addEventListener("change", () => {
    readSettings();
    renderPapers();
    markExportDirty();
    markRankingDirty();
  });
}

window.addEventListener("beforeunload", (event) => {
  if (!state.exportDirty && !state.topicsDirty) return;
  event.preventDefault();
  event.returnValue = "";
});

async function loadCsvText(text, sourceName) {
  const rows = parseCsv(text);
  if (!rows.length) {
    alert("The CSV did not contain any rows.");
    return;
  }
  const missing = REQUIRED_COLUMNS.filter((column) => !(column in rows[0]));
  if (missing.length) {
    alert(missingColumnsMessage(missing));
    return;
  }

  state.papers = rows.map((row, index) => {
    const preference = parsePreference(row.preference);
    return {
      id: `${row.paper || index + 1}`,
      paper: row.paper || String(index + 1),
      title: row.title || "(untitled)",
      preference,
      abstract: row.abstract || "",
      topics: splitTopics(row.topics || ""),
      topicScore: 0,
      modelScore: 0,
      combinedScore: 0,
      topicDisplayScore: 0,
      modelDisplayScore: 0,
      combinedDisplayScore: 0,
      rankReason: "topic_only",
      sentenceHighlights: [],
      expanded: false,
    };
  });

  state.modelWeightManual = false;
  initializeTopicRatings();
  rerankPapers();
  state.rankingDirty = false;
  state.exportDirty = false;
  state.topicsDirty = false;
  renderAll(sourceName);
}

async function loadTopicScores(text) {
  if (!state.papers.length) {
    alert("Load a paper CSV before loading topic scores.");
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    alert("Topic scores file must be JSON.");
    return;
  }
  const scores = parsed.topics && typeof parsed.topics === "object" ? parsed.topics : parsed;
  const currentTopics = new Set(getTopics());
  let loaded = 0;
  for (const [topic, value] of Object.entries(scores)) {
    const rating = Number(value);
    if (currentTopics.has(topic) && Number.isFinite(rating)) {
      state.topicRatings.set(topic, clamp(rating, -3, 3));
      loaded += 1;
    }
  }
  renderTopics();
  state.topicsDirty = false;
  updateTopicSaveState();
  markRankingDirty();
}

function missingColumnsMessage(missing) {
  const message = [`Missing required columns: ${missing.join(", ")}.`];
  if (missing.includes("abstract") || missing.includes("topics")) {
    message.push(
      "This looks like the plain HotCRP preference file. In HotCRP, use Download, choose Preference file with abstracts, and click Go.",
    );
  }
  return message.join("\n\n");
}

function readSettings() {
  const min = Number(els.prefMin.value);
  const neutral = Number(els.prefNeutral.value);
  const max = Number(els.prefMax.value);
  if (!Number.isFinite(min) || !Number.isFinite(neutral) || !Number.isFinite(max) || min >= max) {
    alert("Preference range must have a finite minimum below maximum.");
    return;
  }
  state.settings = {
    preferenceMin: min,
    preferenceNeutral: neutral,
    preferenceMax: max,
  };
  for (const paper of state.papers) {
    paper.preference = clamp(paper.preference, min, max);
  }
}

function initializeTopicRatings() {
  const topics = getTopics();
  const next = new Map();
  for (const topic of topics) {
    next.set(topic, state.topicRatings.get(topic) ?? 0);
  }
  state.topicRatings = next;
}

function getTopics() {
  const counts = new Map();
  for (const paper of state.papers) {
    for (const topic of paper.topics) {
      counts.set(topic, (counts.get(topic) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([topic]) => topic);
}

function rerankPapers() {
  computeTopicScores();
  state.lastLabelStats = labelStats();
  const model = classifiers.linearText.train(state.papers, state.settings);
  const modelActive = model.active;
  state.recommendedModelWeight = recommendedModelWeight(state.lastLabelStats);
  if (!state.modelWeightManual) {
    state.modelWeight = state.recommendedModelWeight;
  }
  const modelWeight = modelActive ? state.modelWeight : 0;

  for (const paper of state.papers) {
    const normalizedTopic = normalizeTopicScore(paper.topicScore);
    paper.modelScore = model.score(paper);
    paper.topicDisplayScore = scaleToPreferenceRange(normalizedTopic);
    paper.modelDisplayScore = modelActive ? scaleToPreferenceRange(paper.modelScore) : 0;
    const normalizedModel = modelActive ? paper.modelScore : 0;
    paper.combinedScore = modelWeight * normalizedModel + (1 - modelWeight) * normalizedTopic;
    paper.combinedDisplayScore = scaleToPreferenceRange(paper.combinedScore);
    paper.rankReason = modelActive ? "blended" : "topic_only";
    paper.sentenceHighlights = modelActive ? model.explain(paper) : [];
  }

  state.lastRankReason = modelActive ? "blended" : "topic_only";
  state.papers.sort((a, b) => {
    return (
      b.combinedScore - a.combinedScore ||
      b.preference - a.preference ||
      Number(a.paper) - Number(b.paper) ||
      a.title.localeCompare(b.title)
    );
  });
  updateModelWeightControls();
}

function computeTopicScores() {
  for (const paper of state.papers) {
    const ratings = paper.topics
      .map((topic) => state.topicRatings.get(topic) || 0)
      .filter((rating) => Number.isFinite(rating));
    paper.topicScore = ratings.length ? average(ratings) : 0;
  }
}

function normalizeTopicScore(score) {
  return (score + 3) / 6;
}

const classifiers = {
  linearText: {
    train(papers, settings) {
      const positive = [];
      const negative = [];
      for (const paper of papers) {
        if (paper.preference > settings.preferenceNeutral) positive.push(paper);
        if (paper.preference < settings.preferenceNeutral) negative.push(paper);
      }
      if (!positive.length || !negative.length) {
        return inactiveModel;
      }

      const documentFrequency = new Map();
      const tokenized = new Map();
      for (const paper of papers) {
        const tokens = tokenize(paperToText(paper));
        tokenized.set(paper.id, tokens);
        for (const token of new Set(tokens)) {
          documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
        }
      }

      const vectors = new Map();
      for (const paper of papers) {
        vectors.set(paper.id, tfidfVector(tokenized.get(paper.id) || [], documentFrequency, papers.length));
      }

      const positiveCentroid = centroid(positive.map((paper) => vectors.get(paper.id)));
      const negativeCentroid = centroid(negative.map((paper) => vectors.get(paper.id)));
      const rawScores = new Map();
      for (const paper of papers) {
        const vector = vectors.get(paper.id);
        rawScores.set(
          paper.id,
          cosineSimilarity(vector, positiveCentroid) - cosineSimilarity(vector, negativeCentroid),
        );
      }
      const values = [...rawScores.values()];
      const min = Math.min(...values);
      const max = Math.max(...values);

      return {
        active: true,
        score(paper) {
          const raw = rawScores.get(paper.id) || 0;
          if (max === min) return 0.5;
          return (raw - min) / (max - min);
        },
        explain(paper) {
          return explainPaperSentences(paper, documentFrequency, papers.length, positiveCentroid, negativeCentroid);
        },
      };
    },
  },
};

const inactiveModel = {
  active: false,
  score() {
    return 0;
  },
  explain() {
    return [];
  },
};

function explainPaperSentences(paper, documentFrequency, totalDocuments, positiveCentroid, negativeCentroid) {
  const sentences = splitSentences(paper.abstract);
  const scored = sentences
    .map((sentence, index) => {
      const vector = tfidfVector(tokenize(sentence), documentFrequency, totalDocuments);
      const score = cosineSimilarity(vector, positiveCentroid) - cosineSimilarity(vector, negativeCentroid);
      return { sentence, index, score };
    })
    .filter((item) => item.sentence && item.score !== 0);
  if (!scored.length) return [];

  const maxAbs = Math.max(...scored.map((item) => Math.abs(item.score)));
  if (!maxAbs) return [];
  const cutoff = Math.max(maxAbs * 0.35, 0.015);
  return scored
    .filter((item) => Math.abs(item.score) >= cutoff)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 5)
    .map((item) => ({
      index: item.index,
      score: item.score,
      intensity: Math.min(1, Math.abs(item.score) / maxAbs),
    }));
}

function tfidfVector(tokens, documentFrequency, totalDocuments) {
  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  const vector = new Map();
  const total = tokens.length || 1;
  for (const [token, count] of counts) {
    const tf = count / total;
    const idf = Math.log((1 + totalDocuments) / (1 + (documentFrequency.get(token) || 0))) + 1;
    vector.set(token, tf * idf);
  }
  return normalizeVector(vector);
}

function centroid(vectors) {
  const result = new Map();
  const used = vectors.filter((vector) => vector && vector.size);
  if (!used.length) return result;
  for (const vector of used) {
    for (const [token, value] of vector) {
      result.set(token, (result.get(token) || 0) + value / used.length);
    }
  }
  return normalizeVector(result);
}

function normalizeVector(vector) {
  const norm = Math.sqrt([...vector.values()].reduce((sum, value) => sum + value * value, 0));
  if (!norm) return vector;
  const normalized = new Map();
  for (const [token, value] of vector) {
    normalized.set(token, value / norm);
  }
  return normalized;
}

function cosineSimilarity(a, b) {
  if (!a?.size || !b?.size) return 0;
  let sum = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [token, value] of small) {
    sum += value * (large.get(token) || 0);
  }
  return sum;
}

function paperToText(paper) {
  return `${paper.title} ${paper.abstract} ${paper.topics.join(" ")}`;
}

function tokenize(text) {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "are",
    "can",
    "into",
    "use",
    "using",
    "our",
    "we",
    "show",
    "paper",
    "study",
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stop.has(token));
}

function renderAll(sourceName) {
  els.emptyState.classList.add("hidden");
  els.workspace.classList.remove("hidden");
  updateLoadDemoVisibility();
  updateExportState();
  updateTopicSaveState();
  renderTopics();
  renderPapers();
  els.rankSummary.textContent = `${rankSummaryText()} Loaded ${state.papers.length} papers from ${sourceName}.`;
}

function renderTopics() {
  const topics = getTopics();
  els.topicCount.textContent = `${topics.length}`;
  els.topics.replaceChildren(
    ...topics.map((topic) => {
      const row = document.createElement("div");
      row.className = "topic-row";
      const label = document.createElement("label");
      label.className = "topic-label";
      label.innerHTML = `<strong>${escapeHtml(topic)}</strong><span>${state.topicRatings.get(topic) || 0}</span>`;
      const input = document.createElement("input");
      input.type = "range";
      input.min = "-3";
      input.max = "3";
      input.step = "1";
      input.value = String(state.topicRatings.get(topic) || 0);
      input.className = topicScoreStateClass(Number(input.value));
      input.addEventListener("input", () => {
        state.topicRatings.set(topic, Number(input.value));
        label.querySelector("span").textContent = input.value;
        input.className = topicScoreStateClass(Number(input.value));
        markTopicsDirty();
        markRankingDirty();
      });
      row.append(label, input);
      return row;
    }),
  );
}

function renderPapers() {
  const hideRated = els.hideRated.checked;
  const neutral = state.settings.preferenceNeutral;
  const visible = hideRated
    ? state.papers.filter((paper) => paper.preference === neutral)
    : state.papers;
  const stats = labelStats();
  els.paperCount.textContent = `${state.papers.length} papers, ${stats.positive + stats.negative} ranked`;
  els.rankSummary.textContent = rankSummaryText();
  els.papers.replaceChildren(...visible.map(renderPaperCard));
  updateRerankState();
}

function renderPaperCard(paper) {
  const article = document.createElement("article");
  article.className = `paper-card ${scoreStateClass(paper.preference)}`;

  const body = document.createElement("div");
  const title = document.createElement("h3");
  title.className = "paper-title";
  title.textContent = `#${paper.paper} ${paper.title}`;
  const meta = document.createElement("div");
  meta.className = "paper-meta";
  if (paper.topics.length) {
    for (const topic of paper.topics) {
      const chip = document.createElement("span");
      chip.className = "topic-chip";
      chip.textContent = topic;
      meta.append(chip);
    }
  } else {
    meta.textContent = "No topics";
  }
  const abstract = document.createElement("p");
  abstract.className = "abstract";
  const isLong = paper.abstract.length > 560;
  renderAbstractText(abstract, paper);
  body.append(title, meta, abstract);
  if (isLong) {
    const abstractButton = document.createElement("button");
    abstractButton.type = "button";
    abstractButton.className = "link-button";
    abstractButton.textContent = paper.expanded ? "Hide full abstract" : "Show full abstract";
    abstractButton.addEventListener("click", () => {
      paper.expanded = !paper.expanded;
      renderAbstractText(abstract, paper);
      abstractButton.textContent = paper.expanded ? "Hide full abstract" : "Show full abstract";
    });
    body.append(abstractButton);
  }

  const controls = document.createElement("div");
  controls.className = "paper-controls";
  const scoreRow = document.createElement("div");
  scoreRow.className = "paper-score-row";
  const scoreLabel = document.createElement("label");
  scoreLabel.className = "score-label";
  scoreLabel.innerHTML = `<strong>Preference</strong><span class="${scoreValueClass(paper.preference)}">${paper.preference}</span>`;
  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = `preference-slider ${scoreStateClass(paper.preference)}`;
  slider.min = String(state.settings.preferenceMin);
  slider.max = String(state.settings.preferenceMax);
  slider.step = "1";
  slider.value = String(paper.preference);
  slider.addEventListener("input", () => {
    paper.preference = Number(slider.value);
    const value = scoreLabel.querySelector("span");
    value.textContent = slider.value;
    value.className = scoreValueClass(paper.preference);
    slider.className = `preference-slider ${scoreStateClass(paper.preference)}`;
    article.className = `paper-card ${scoreStateClass(paper.preference)}`;
    markExportDirty();
    markRankingDirty();
  });
  scoreRow.append(scoreLabel, slider);

  const readout = document.createElement("div");
  readout.className = "score-readout";
  readout.innerHTML = `
    <span><b>Rank score</b><em>${formatDisplayScore(paper.combinedDisplayScore)}</em></span>
    <span><b>Topic score</b><em>${formatDisplayScore(paper.topicDisplayScore)}</em></span>
    <span><b>Text score</b><em>${formatDisplayScore(paper.modelDisplayScore)}</em></span>
    <span><b>Ranking</b><em>${rankReasonText(paper.rankReason)}</em></span>
  `;
  controls.append(scoreRow, readout);
  article.append(body, controls);
  return article;
}

function rankSummaryText() {
  const stats = labelStats();
  const pending = state.rankingDirty ? "Ranking changes pending. " : "";
  if (state.lastRankReason === "blended") {
    const topicWeight = 1 - state.modelWeight;
    return `${pending}Ranked by ${percent(state.modelWeight)} text model / ${percent(topicWeight)} topics. ${labelStatsText(stats)}`;
  }
  const classifierNote = stats.balanced === 0
    ? " Text model needs at least 1 positive and 1 negative paper score."
    : "";
  return `${pending}Ranked by topics only.${classifierNote} ${labelStatsText(stats)}`;
}

function labelStats() {
  const positivePapers = state.papers.filter((paper) => paper.preference > state.settings.preferenceNeutral);
  const positive = positivePapers.length;
  const negative = state.papers.filter((paper) => paper.preference < state.settings.preferenceNeutral).length;
  const unranked = state.papers.length - positive - negative;
  const positiveBands = positiveBandCounts(positivePapers);
  return {
    positive,
    positiveHigh: positiveBands.high,
    positiveMid: positiveBands.mid,
    positiveLow: positiveBands.low,
    negative,
    unranked,
    balanced: Math.min(positive, negative),
  };
}

function positiveBandCounts(positivePapers) {
  const { preferenceNeutral, preferenceMax } = state.settings;
  const positiveRange = preferenceMax - preferenceNeutral;
  const counts = { high: 0, mid: 0, low: 0 };
  for (const paper of positivePapers) {
    if (positiveRange <= 0) {
      counts.high += 1;
      continue;
    }
    const position = (paper.preference - preferenceNeutral) / positiveRange;
    if (position > 2 / 3) counts.high += 1;
    else if (position > 1 / 3) counts.mid += 1;
    else counts.low += 1;
  }
  return counts;
}

function labelStatsText(stats) {
  const positiveDetail = stats.positive
    ? `${stats.positive} positive (${stats.positiveHigh} high, ${stats.positiveMid} mid, ${stats.positiveLow} low)`
    : "0 positive";
  return `${positiveDetail}, ${stats.negative} negative, ${stats.unranked} unranked.`;
}

function recommendedModelWeight(stats) {
  return stats.balanced / (stats.balanced + 5);
}

function updateModelWeightControls() {
  const stats = labelStats();
  const modelAvailable = stats.balanced > 0;
  els.modelWeight.disabled = !modelAvailable;
  els.modelWeightReset.disabled = !modelAvailable || !state.modelWeightManual;
  els.modelWeight.value = String(Math.round(state.modelWeight * 100));
  els.modelWeightValue.textContent = modelAvailable
    ? `${percent(state.modelWeight)} text / ${percent(1 - state.modelWeight)} topics; recommended ${percent(state.recommendedModelWeight)} text`
    : "Text model needs at least 1 positive and 1 negative score";
  els.modelWeightLabel.textContent = modelAvailable
    ? "Text model weight"
    : "Text model weight unavailable";
}

function markRankingDirty() {
  if (!state.papers.length) return;
  state.rankingDirty = true;
  state.lastLabelStats = labelStats();
  state.recommendedModelWeight = recommendedModelWeight(state.lastLabelStats);
  if (!state.modelWeightManual) {
    state.modelWeight = state.recommendedModelWeight;
  }
  updateModelWeightControls();
  updateRerankState();
  els.rankSummary.textContent = rankSummaryText();
}

function markExportDirty() {
  if (!state.papers.length) return;
  state.exportDirty = true;
  updateExportState();
}

function updateExportState() {
  els.exportCsv.disabled = !state.papers.length || !state.exportDirty;
  els.exportCsv.textContent = "Export CSV";
  els.exportCsv.title = state.exportDirty
    ? "Preference changes have not been exported."
    : "No preference changes to export.";
}

function updateLoadDemoVisibility() {
  els.loadExample.classList.toggle("hidden", state.papers.length > 0);
}

function markTopicsDirty() {
  if (!state.papers.length) return;
  state.topicsDirty = true;
  updateTopicSaveState();
}

function updateTopicSaveState() {
  els.saveTopics.disabled = !state.papers.length || !state.topicsDirty;
  els.saveTopics.textContent = "Save topic scores";
  els.saveTopics.title = state.topicsDirty
    ? "Topic score changes have not been saved."
    : "No topic score changes to save.";
}

function confirmDiscardUnsavedChanges(action) {
  if (!state.exportDirty && !state.topicsDirty) return true;
  const items = [
    state.exportDirty ? "preference changes that have not been exported" : "",
    state.topicsDirty ? "topic score changes that have not been saved" : "",
  ].filter(Boolean);
  return window.confirm(`You have ${items.join(" and ")}. Continue to ${action} and discard them?`);
}

function confirmDiscardTopicChanges(action) {
  if (!state.topicsDirty) return true;
  return window.confirm(`You have topic score changes that have not been saved. Continue to ${action} and discard them?`);
}

function updateRerankState() {
  els.rerank.disabled = !state.papers.length || !state.rankingDirty;
  els.rerank.textContent = state.rankingDirty ? "Re-rank" : "Ranked";
}

function scoreStateClass(preference) {
  if (preference > state.settings.preferenceNeutral) return "score-positive";
  if (preference < state.settings.preferenceNeutral) return "score-negative";
  return "score-unranked";
}

function topicScoreStateClass(score) {
  if (score > 0) return "score-positive";
  if (score < 0) return "score-negative";
  return "score-unranked";
}

function scoreValueClass(preference) {
  if (preference > state.settings.preferenceNeutral) return "positive";
  if (preference < state.settings.preferenceNeutral) return "negative";
  return "unranked";
}

function rankReasonText(reason) {
  return reason === "blended" ? "topics + text" : "topics only";
}

function renderAbstractText(container, paper) {
  container.replaceChildren();
  const sentences = splitSentences(paper.abstract);
  if (!sentences.length) {
    container.textContent = "";
    return;
  }

  const highlights = new Map((paper.sentenceHighlights || []).map((item) => [item.index, item]));
  const maxLength = paper.expanded ? Infinity : 560;
  let used = 0;

  sentences.some((sentence, index) => {
    const separator = used ? " " : "";
    const remaining = maxLength - used - separator.length;
    if (remaining <= 0) return true;

    let visibleSentence = sentence;
    let done = false;
    if (visibleSentence.length > remaining) {
      visibleSentence = `${visibleSentence.slice(0, Math.max(0, remaining - 1)).trimEnd()}…`;
      done = true;
    }

    if (separator) container.append(document.createTextNode(separator));
    const highlight = highlights.get(index);
    if (highlight) {
      const span = document.createElement("span");
      span.className = `sentence-highlight ${highlight.score > 0 ? "positive-highlight" : "negative-highlight"} intensity-${highlightIntensity(highlight.intensity)}`;
      span.title = `${highlight.score > 0 ? "Positive" : "Negative"} text-model signal`;
      span.textContent = visibleSentence;
      container.append(span);
    } else {
      container.append(document.createTextNode(visibleSentence));
    }
    used += separator.length + visibleSentence.length;
    return done;
  });
}

function highlightIntensity(value) {
  if (value >= 0.72) return 3;
  if (value >= 0.44) return 2;
  return 1;
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function parsePreference(value) {
  const number = Number(String(value || "0").replace(/[A-Za-z]+$/, ""));
  return Number.isFinite(number) ? number : 0;
}

function splitTopics(value) {
  return value
    .split(";")
    .map((topic) => topic.trim())
    .filter(Boolean);
}

function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [];
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift()?.map((name) => name.trim()) || [];
  return rows
    .filter((values) => values.some((value) => value.trim() !== ""))
    .map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] || ""])));
}

function serializeCsv(columns, rows) {
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column] || "")).join(",")),
  ].join("\n") + "\n";
}

function csvEscape(value) {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatScore(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "0.000";
}

function scaleToPreferenceRange(normalizedScore) {
  const { preferenceMin, preferenceNeutral, preferenceMax } = state.settings;
  if (normalizedScore <= 0.5) {
    return preferenceMin + (normalizedScore / 0.5) * (preferenceNeutral - preferenceMin);
  }
  return preferenceNeutral + ((normalizedScore - 0.5) / 0.5) * (preferenceMax - preferenceNeutral);
}

function formatDisplayScore(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char];
  });
}
