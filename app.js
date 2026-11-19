const LOCAL_DB_NAME = "chemistry-study-space";
const LOCAL_DB_VERSION = 1;
const LOCAL_TEACHER_UID = "local-teacher";
const IMAGE_LIMIT = 15 * 1024 * 1024;
const RESOURCE_LIMIT = 50 * 1024 * 1024;
const VIDEO_LIMIT = 100 * 1024 * 1024;
const pages = {
  home: document.getElementById("home-page"),
  units: document.getElementById("units-page"),
  questions: document.getElementById("questions-page"),
  challenge: document.getElementById("challenge-page"),
};
let client = null;
let currentUser = null;
let isTeacher = false;
let questionLoadRevision = 0;
let resources = [];
let questions = [];
let editingQuestion = null;
let challenge = null;
let databasePromise = null;
const mediaUrls = new Map();

function openLocalDatabase() {
  if (!window.indexedDB) return Promise.reject(new Error("This browser does not support local storage for class content."));
  if (databasePromise) return databasePromise;

  const request = window.indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
  const opening = new Promise((resolve, reject) => {
    request.onupgradeneeded = () => {
      const database = request.result;
      ["unit_resources", "questions", "question_solutions", "settings"].forEach((name) => {
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath: "id" });
      });
      if (!database.objectStoreNames.contains("media")) database.createObjectStore("media", { keyPath: "path" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open browser storage."));
    request.onblocked = () => reject(new Error("Close other tabs of this site, then reload."));
  });
  databasePromise = opening;
  opening.catch(() => {
    if (databasePromise === opening) databasePromise = null;
  });
  return opening;
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Browser storage request failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Browser storage request was cancelled."));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Browser storage request failed."));
  });
}

async function getLocalRecord(storeName, id) {
  const database = await openLocalDatabase();
  const transaction = database.transaction(storeName, "readonly");
  return requestResult(transaction.objectStore(storeName).get(id));
}

async function getLocalRecords(storeName) {
  const database = await openLocalDatabase();
  const transaction = database.transaction(storeName, "readonly");
  return requestResult(transaction.objectStore(storeName).getAll());
}

async function putLocalRecord(storeName, record) {
  const database = await openLocalDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  const complete = transactionComplete(transaction);
  transaction.objectStore(storeName).put(record);
  await complete;
}

async function deleteLocalRecord(storeName, id) {
  const database = await openLocalDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  const complete = transactionComplete(transaction);
  transaction.objectStore(storeName).delete(id);
  await complete;
}

function createLocalDatabaseAdapter() {
  function documentReference(collection, id) {
    return {
      collection,
      id,
      async get() {
        const record = await getLocalRecord(collection, id);
        return { exists: Boolean(record), data: () => record };
      },
      set(record) {
        return putLocalRecord(collection, { ...record, id });
      },
      delete() {
        return deleteLocalRecord(collection, id);
      },
    };
  }

  return {
    collection(name) {
      return {
        orderBy(field, direction = "asc") {
          return {
            async get() {
              const records = await getLocalRecords(name);
              records.sort((left, right) => {
                const comparison = String(left[field] || "").localeCompare(String(right[field] || ""));
                return direction === "desc" ? -comparison : comparison;
              });
              return { docs: records.map((record) => ({ id: record.id, data: () => record })) };
            },
          };
        },
        doc(id) {
          return documentReference(name, id);
        },
      };
    },
    batch() {
      const operations = [];
      return {
        set(reference, record) {
          operations.push({ type: "set", reference, record });
        },
        delete(reference) {
          operations.push({ type: "delete", reference });
        },
        async commit() {
          const database = await openLocalDatabase();
          const storeNames = [...new Set(operations.map((operation) => operation.reference.collection))];
          const transaction = database.transaction(storeNames, "readwrite");
          const complete = transactionComplete(transaction);
          operations.forEach((operation) => {
            const store = transaction.objectStore(operation.reference.collection);
            if (operation.type === "set") store.put({ ...operation.record, id: operation.reference.id });
            else store.delete(operation.reference.id);
          });
          await complete;
        },
      };
    },
  };
}

async function localMediaUrl(path) {
  if (mediaUrls.has(path)) return mediaUrls.get(path);
  const storedMedia = await getLocalRecord("media", path);
  if (!storedMedia || !storedMedia.blob) throw new Error("This attachment is missing from this browser.");
  const url = URL.createObjectURL(storedMedia.blob);
  mediaUrls.set(path, url);
  return url;
}

function createLocalStorageAdapter() {
  return {
    ref(path) {
      return {
        fullPath: path,
        async put(file) {
          await putLocalRecord("media", { path, blob: file, name: file.name, type: file.type });
        },
        getDownloadURL() {
          return localMediaUrl(path);
        },
        async delete() {
          const objectUrl = mediaUrls.get(path);
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          mediaUrls.delete(path);
          await deleteLocalRecord("media", path);
        },
      };
    },
  };
}

async function checkLocalAnswer({ questionId, choice }) {
  const snapshot = await client.db.collection("question_solutions").doc(questionId).get();
  if (!snapshot.exists) throw new Error("This question or its answer explanation is unavailable.");
  const solution = snapshot.data();
  const selectedOption = String(choice || "").trim().toUpperCase();
  if (!["A", "B", "C", "D"].includes(selectedOption)) throw new Error("Choose A, B, C, or D.");
  return {
    data: {
      is_correct: solution.correct_option === selectedOption,
      correct_option: solution.correct_option,
      explanation: solution.explanation || "",
      explanation_video_url: solution.explanation_video_url || null,
      explanation_video_path: solution.explanation_video_path || null,
      explanation_video_storage_url: solution.explanation_video_path
        ? await localMediaUrl(solution.explanation_video_path)
        : null,
    },
  };
}

function setConnectionMessage(message, visible = true) {
  const banner = document.getElementById("connection-banner");
  banner.textContent = message;
  banner.hidden = !visible;
}

function showStatus(id, message, isError = false) {
  const status = document.getElementById(id);
  status.textContent = message;
  status.classList.toggle("status-error", isError);
}

function showPage(name) {
  Object.entries(pages).forEach(([pageName, page]) => {
    const active = pageName === name;
    page.hidden = !active;
    page.classList.toggle("active", active);
  });
  document.querySelectorAll(".nav-link").forEach((button) => {
    const active = button.dataset.page === name;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (name === "units") renderResources();
  if (name === "questions") renderQuestions();
}

document.querySelectorAll("[data-page]").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    showPage(button.dataset.page);
  });
});

function newId() {
  return window.crypto && typeof window.crypto.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
    .format(new Date(value));
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timestampValue(value) {
  return value && typeof value.toDate === "function" ? value.toDate().toISOString() : value;
}

function safeFileName(name) {
  return name.normalize("NFKD").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "attachment";
}

function fileFromForm(data, name) {
  const file = data.get(name);
  return file && file.size > 0 ? file : null;
}

function setTeacherControls() {
  document.getElementById("login-open").hidden = Boolean(currentUser);
  document.getElementById("user-panel").hidden = !currentUser;
  document.getElementById("resource-form").hidden = !isTeacher;
  document.getElementById("new-question-button").hidden = !isTeacher;
  if (!isTeacher) document.getElementById("question-form").hidden = true;
  document.getElementById("units-page").classList.toggle("teacher-view", isTeacher);
  document.querySelector("#user-panel small").textContent = isTeacher ? "TEACHER ACCESS" : "NO TEACHER ACCESS";
  if (currentUser) {
    document.getElementById("user-email").textContent = currentUser.email || "Teacher account";
  }
}

function setEmpty(list, count, title, detail) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.append(
    textElement("span", "", "✧"),
    textElement("strong", "", title),
    textElement("p", "", detail),
  );
  list.replaceChildren(empty);
  if (count) count.textContent = "0";
}

async function loadResources() {
  if (!client) return;
  const list = document.getElementById("resource-list");
  const count = document.getElementById("resource-count");
  showStatus("resource-status", "");
  try {
    const snapshot = await client.db.collection("unit_resources").orderBy("created_at", "desc").get();
    resources = await Promise.all(snapshot.docs.map(async (doc) => {
      const resource = doc.data();
      return {
        ...resource,
        id: doc.id,
        file_url: await localMediaUrl(resource.file_path),
        created_at: timestampValue(resource.created_at),
      };
    }));
    renderResources();
  } catch (error) {
    showStatus("resource-status", `Could not load unit materials: ${error.message}`, true);
    setEmpty(list, count, "Materials unavailable", "Check the connection or ask your teacher for help.");
  }
}

function createResourceCard(resource) {
  const card = document.createElement("article");
  card.className = "resource-card";
  const icon = textElement("span", "resource-icon", resource.file_name.toLowerCase().endsWith(".pdf") ? "PDF" : "PPT");
  icon.setAttribute("aria-hidden", "true");
  const details = document.createElement("div");
  details.className = "resource-details";
  details.append(textElement("h3", "resource-title", resource.title));
  details.append(textElement("p", "resource-meta", `${resource.file_name} · ${formatDate(resource.created_at)}`));
  const actions = document.createElement("div");
  actions.className = "resource-actions";
  const link = document.createElement("a");
  link.className = "button button-secondary button-small";
  link.href = resource.file_url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Open file ↗";
  actions.append(link);
  if (isTeacher) {
    const remove = document.createElement("button");
    remove.className = "entry-action delete-action";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => deleteResource(resource, remove));
    actions.append(remove);
  }
  card.append(icon, details, actions);
  return card;
}

function renderResources() {
  const list = document.getElementById("resource-list");
  const count = document.getElementById("resource-count");
  count.textContent = String(resources.length);
  if (!resources.length) {
    setEmpty(list, null, "No unit files yet", "Your teacher's slides and handouts will appear here.");
    count.textContent = "0";
    return;
  }
  list.replaceChildren(...resources.map(createResourceCard));
}

async function uploadMedia(path, file) {
  const reference = client.storage.ref(path);
  const metadata = file.type ? { contentType: file.type } : undefined;
  await reference.put(file, metadata);
  try {
    return {
      path: reference.fullPath,
      url: await reference.getDownloadURL(),
    };
  } catch (error) {
    try {
      await reference.delete();
    } catch (cleanupError) {
      throw new Error(`${error.message} Uploaded file cleanup failed: ${cleanupError.message}`);
    }
    throw error;
  }
}

async function removeMedia(paths) {
  const existing = paths.filter(Boolean);
  if (!existing.length) return;
  await Promise.all(existing.map((path) => client.storage.ref(path).delete()));
}

function validResourceFile(file) {
  const extension = file.name.split(".").pop().toLowerCase();
  return ["ppt", "pptx", "pdf"].includes(extension);
}

document.getElementById("resource-file").addEventListener("change", (event) => {
  const file = event.currentTarget.files[0];
  document.getElementById("resource-file-name").textContent = file ? file.name : "No file selected";
  showStatus("resource-message", "");
});

document.getElementById("resource-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!client || !isTeacher || !currentUser) {
    showStatus("resource-message", "Only the teacher can upload unit files.", true);
    return;
  }
  const form = event.currentTarget;
  const data = new FormData(form);
  const file = fileFromForm(data, "file");
  if (!file || !validResourceFile(file)) {
    showStatus("resource-message", "Choose a PowerPoint (.ppt or .pptx) or PDF file.", true);
    return;
  }
  if (file.size > RESOURCE_LIMIT) {
    showStatus("resource-message", "This file is larger than 50 MB. Choose a smaller file.", true);
    return;
  }
  const id = newId();
  const path = `${currentUser.uid}/units/${id}/${safeFileName(file.name)}`;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  showStatus("resource-message", "");
  try {
    const media = await uploadMedia(path, file);
    const title = data.get("title").trim() || file.name;
    try {
      await client.db.collection("unit_resources").doc(id).set({
        id,
        title,
        file_path: media.path,
        file_url: media.url,
        file_name: file.name,
        file_type: file.type || "application/octet-stream",
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      try {
        await removeMedia([media.path]);
      } catch (cleanupError) {
        throw new Error(`Could not save the file record: ${error.message}. Uploaded file cleanup failed: ${cleanupError.message}`);
      }
      throw new Error(`Could not save the file record: ${error.message}`);
    }
    form.reset();
    document.getElementById("resource-file-name").textContent = "No file selected";
    resources.unshift({
      id,
      title,
      file_path: media.path,
      file_url: media.url,
      file_name: file.name,
      file_type: file.type || "application/octet-stream",
      created_at: new Date().toISOString(),
    });
    renderResources();
  } catch (error) {
    showStatus("resource-message", `Could not upload this file: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

async function deleteResource(resource, button) {
  if (!isTeacher) return;
  if (!window.confirm(`Remove "${resource.title}" from unit review?`)) return;
  button.disabled = true;
  try {
    await client.db.collection("unit_resources").doc(resource.id).delete();
    resources = resources.filter((item) => item.id !== resource.id);
    renderResources();
    try {
      await removeMedia([resource.file_path]);
    } catch (cleanupError) {
      showStatus("resource-status", `File removed from the library, but storage cleanup failed: ${cleanupError.message}`, true);
    }
  } catch (error) {
    button.disabled = false;
    showStatus("resource-status", `Could not remove this file: ${error.message}`, true);
  }
}

async function loadQuestions() {
  if (!client) return;
  const revision = ++questionLoadRevision;
  const list = document.getElementById("questions-list");
  const count = document.getElementById("question-count");
  showStatus("questions-status", "");
  setEmpty(list, count, "Loading questions", "Getting the class question set...");
  try {
    const snapshot = await client.db.collection("questions").orderBy("created_at", "desc").get();
    if (revision !== questionLoadRevision) return;
    questions = await Promise.all(snapshot.docs.map(async (doc) => {
      const question = doc.data();
      return {
        ...question,
        id: doc.id,
        image_url: question.image_path ? await localMediaUrl(question.image_path) : null,
        created_at: timestampValue(question.created_at),
      };
    }));
    renderQuestions();
  } catch (error) {
    if (revision !== questionLoadRevision) return;
    showStatus("questions-status", `Could not load Regents questions: ${error.message}`, true);
    setEmpty(list, count, "Questions unavailable", "Check your connection or ask your teacher for help.");
  }
}

function renderQuestions() {
  const list = document.getElementById("questions-list");
  const count = document.getElementById("question-count");
  const visibleQuestions = isTeacher ? questions : questions.filter(isValidMcq);
  count.textContent = String(visibleQuestions.length);
  if (!visibleQuestions.length) {
    setEmpty(list, null, "No practice questions yet", "Your teacher's Regents questions will appear here.");
    count.textContent = "0";
    return;
  }
  const legacyCount = visibleQuestions.filter((question) => !isValidMcq(question)).length;
  showStatus("questions-status", legacyCount ? `${legacyCount} old question(s) need to be recreated as multiple choice before students can use them.` : "");
  list.replaceChildren(...visibleQuestions.map((question) => createQuestionCard(question, "review")));
}

function isValidMcq(question) {
  return Boolean(question.prompt && question.prompt.trim()
    && ["a", "b", "c", "d"].every((letter) => question[`choice_${letter}`] && question[`choice_${letter}`].trim()));
}

function createChoice(question, letter, groupName) {
  const label = document.createElement("label");
  label.className = "mcq-choice";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = groupName;
  input.value = letter;
  input.required = true;
  const letterBadge = textElement("span", "choice-letter", letter);
  const choiceText = textElement("span", "choice-text", question[`choice_${letter.toLowerCase()}`]);
  label.append(input, letterBadge, choiceText);
  return label;
}

function createQuestionCard(question, mode, onChallengeAnswer, onChallengeSkip) {
  const card = document.createElement("article");
  card.className = "entry-card question-card";
  const header = document.createElement("div");
  header.className = "entry-card-top";
  const titleGroup = document.createElement("div");
  titleGroup.style.flex = "1";
  titleGroup.append(textElement("h3", "entry-title", question.topic || "Regents practice"));
  titleGroup.append(textElement("p", "entry-meta", formatDate(question.created_at)));
  header.append(titleGroup);
  const validQuestion = isValidMcq(question);
  if (isTeacher && mode === "review") {
    const actions = document.createElement("div");
    actions.className = "entry-actions";
    if (validQuestion) {
      const edit = document.createElement("button");
      edit.className = "entry-action";
      edit.type = "button";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => openQuestionEditor(question));
      actions.append(edit);
    }
    const remove = document.createElement("button");
    remove.className = "entry-action delete-action";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => deleteQuestion(question, remove));
    actions.append(remove);
    header.append(actions);
  }
  card.append(header);
  if (!validQuestion) {
    card.append(textElement("p", "legacy-warning", "This older question is not a complete multiple-choice item. Remove it and add it again with choices and an answer key."));
    return card;
  }
  card.append(textElement("p", "question-prompt", question.prompt));
  if (question.image_url) {
    const image = document.createElement("img");
    image.className = "question-image";
    image.src = question.image_url;
    image.alt = question.topic ? `Image for ${question.topic}` : "Regents question image";
    card.append(image);
  }
  const answerForm = document.createElement("form");
  answerForm.className = "mcq-form";
  const choices = document.createElement("div");
  choices.className = "choice-grid";
  const radioGroup = `${mode}-${question.id}-${newId()}`;
  ["A", "B", "C", "D"].forEach((letter) => choices.append(createChoice(question, letter, radioGroup)));
  const controls = document.createElement("div");
  controls.className = "mcq-controls";
  const skip = document.createElement("button");
  skip.className = "text-button skip-button";
  skip.type = "button";
  skip.textContent = "Skip question";
  const submit = document.createElement("button");
  submit.className = "button button-primary";
  submit.type = "submit";
  submit.textContent = "Check answer";
  controls.append(skip, submit);
  answerForm.append(choices, controls);

  const skipped = document.createElement("div");
  skipped.className = "skipped-message";
  skipped.hidden = true;
  skipped.append(textElement("span", "", "Skipped for now."));
  const tryAgain = document.createElement("button");
  tryAgain.className = "text-button";
  tryAgain.type = "button";
  tryAgain.textContent = "Try this question";
  skipped.append(tryAgain);

  const feedback = document.createElement("div");
  feedback.className = "answer-feedback";
  feedback.hidden = true;
  card.append(answerForm, skipped, feedback);

  skip.addEventListener("click", () => {
    if (mode === "challenge") {
      onChallengeSkip();
      return;
    }
    answerForm.hidden = true;
    skipped.hidden = false;
    card.classList.add("is-skipped");
  });
  tryAgain.addEventListener("click", () => {
    answerForm.hidden = false;
    skipped.hidden = true;
    card.classList.remove("is-skipped");
  });
  answerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = answerForm.querySelector('input[type="radio"]:checked');
    if (!selected) {
      showStatus("questions-status", "Choose A, B, C, or D before checking your answer.", true);
      return;
    }
    checkAnswer(question, selected.value, card, answerForm, feedback, submit, mode, onChallengeAnswer);
  });
  return card;
}

async function checkAnswer(question, selectedOption, card, form, feedback, submit, mode, onChallengeAnswer) {
  if (!client) return;
  submit.disabled = true;
  showStatus("questions-status", "");
  try {
    const response = await client.answerCheck({ questionId: question.id, choice: selectedOption });
    const result = response.data;
    if (!result || typeof result.is_correct !== "boolean") {
      throw new Error("The answer check did not return a valid result.");
    }
    form.hidden = true;
    renderAnswerFeedback(question, selectedOption, result, feedback);
    feedback.hidden = false;
    card.classList.add(result.is_correct ? "answer-correct" : "answer-incorrect");
    if (mode === "challenge") onChallengeAnswer(result.is_correct);
  } catch (error) {
    showStatus("questions-status", `Could not check this answer: ${error.message}`, true);
    submit.disabled = false;
  }
}

function renderAnswerFeedback(question, selectedOption, result, container) {
  const correct = Boolean(result.is_correct);
  container.replaceChildren();
  const heading = textElement("strong", correct ? "feedback-title feedback-good" : "feedback-title feedback-review",
    correct ? "Correct — nice work." : "Not quite. Review this one.");
  container.append(heading);
  if (!correct) {
    const correctChoice = question[`choice_${String(result.correct_option).toLowerCase()}`];
    container.append(textElement("p", "correct-answer", `Correct answer: ${result.correct_option}. ${correctChoice}`));
  }
  if (result.explanation) {
    const explanation = document.createElement("p");
    explanation.className = "explanation-copy";
    explanation.textContent = result.explanation;
    container.append(explanation);
  }
  if (result.explanation_video_path) {
    const video = document.createElement("video");
    video.className = "explanation-video";
    video.controls = true;
    video.preload = "metadata";
    video.src = result.explanation_video_storage_url;
    video.setAttribute("aria-label", "Teacher's video explanation");
    container.append(video);
  }
  if (result.explanation_video_url) {
    const link = document.createElement("a");
    link.className = "video-link";
    link.href = result.explanation_video_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Watch the video explanation ↗";
    container.append(link);
  }
  if (challenge && challenge.active && container.closest("#challenge-question")) {
    const next = document.createElement("button");
    next.className = "button button-primary next-challenge";
    next.type = "button";
    next.textContent = challenge.index + 1 === challenge.items.length ? "See results" : "Next question";
    next.addEventListener("click", () => advanceChallenge(false));
    container.append(next);
  }
  if (selectedOption === result.correct_option && !correct) {
    container.append(textElement("p", "explanation-copy", "Your answer was recorded as incorrect."));
  }
}

async function openQuestionEditor(question) {
  if (!isTeacher) return;
  const form = document.getElementById("question-form");
  editingQuestion = question || null;
  form.reset();
  showStatus("question-message", "");
  document.getElementById("question-form-title").textContent = question ? "Edit question" : "Add a Regents question";
  document.getElementById("question-submit-label").textContent = question ? "Save changes" : "Save question";
  document.getElementById("question-image-name").textContent = "No file selected";
  document.getElementById("explanation-video-name").textContent = "No file selected";
  document.getElementById("question-image-hint").textContent = question && question.image_path ? "An image is attached. Choose a new image to replace it." : "";
  document.getElementById("explanation-video-hint").textContent = "";
  if (question) {
    try {
      const solutionSnapshot = await client.db.collection("question_solutions").doc(question.id).get();
      if (!solutionSnapshot.exists) throw new Error("The answer key is unavailable.");
      const solution = solutionSnapshot.data();
      question.solution = solution;
      form.elements.topic.value = question.topic || "";
      form.elements.prompt.value = question.prompt;
      form.elements.choice_a.value = question.choice_a;
      form.elements.choice_b.value = question.choice_b;
      form.elements.choice_c.value = question.choice_c;
      form.elements.choice_d.value = question.choice_d;
      form.elements.correct_option.value = solution.correct_option;
      form.elements.explanation.value = solution.explanation || "";
      form.elements.explanation_url.value = solution.explanation_video_url || "";
      if (solution.explanation_video_path) {
        document.getElementById("explanation-video-hint").textContent = "A video is attached. Choose a new video to replace it.";
      }
    } catch (error) {
      showStatus("question-message", `Could not load this question's answer key: ${error.message}`, true);
      return;
    }
  }
  form.hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("question-prompt").focus({ preventScroll: true });
}

function closeQuestionEditor() {
  if (editingQuestion) delete editingQuestion.solution;
  editingQuestion = null;
  const form = document.getElementById("question-form");
  form.reset();
  form.hidden = true;
  document.getElementById("question-image-name").textContent = "No file selected";
  document.getElementById("explanation-video-name").textContent = "No file selected";
  document.getElementById("question-image-hint").textContent = "";
  document.getElementById("explanation-video-hint").textContent = "";
  showStatus("question-message", "");
}

document.getElementById("new-question-button").addEventListener("click", () => openQuestionEditor(null));
document.getElementById("cancel-question").addEventListener("click", closeQuestionEditor);
document.getElementById("question-image").addEventListener("change", (event) => {
  const file = event.currentTarget.files[0];
  document.getElementById("question-image-name").textContent = file ? file.name : "No file selected";
  document.getElementById("question-image-hint").textContent = file
    ? `${formatSize(file.size)} selected`
    : editingQuestion && editingQuestion.image_path ? "An image is attached. Choose a new image to replace it." : "";
});
document.getElementById("explanation-video").addEventListener("change", (event) => {
  const file = event.currentTarget.files[0];
  document.getElementById("explanation-video-name").textContent = file ? file.name : "No file selected";
  document.getElementById("explanation-video-hint").textContent = file
    ? `${formatSize(file.size)} selected`
    : editingQuestion && editingQuestion.solution && editingQuestion.solution.explanation_video_path
      ? "A video is attached. Choose a new video to replace it."
      : "";
});

async function uploadQuestion(questionId, imageFile, videoFile, videoUrl, oldSolution) {
  const uploaded = [];
  let imagePath = editingQuestion ? editingQuestion.image_path : null;
  let imageUrl = editingQuestion ? editingQuestion.image_url : null;
  let videoPath = oldSolution ? oldSolution.explanation_video_path : null;
  let videoStorageUrl = oldSolution ? oldSolution.explanation_video_storage_url : null;
  try {
    if (imageFile) {
      const media = await uploadMedia(`${currentUser.uid}/questions/${questionId}/${newId()}-${safeFileName(imageFile.name)}`, imageFile);
      imagePath = media.path;
      imageUrl = media.url;
      uploaded.push(media.path);
    }
    if (videoFile) {
      const media = await uploadMedia(`${currentUser.uid}/explanations/${questionId}/${newId()}-${safeFileName(videoFile.name)}`, videoFile);
      videoPath = media.path;
      videoStorageUrl = media.url;
      uploaded.push(media.path);
    } else if (videoUrl) {
      videoPath = null;
      videoStorageUrl = null;
    }
    return { imagePath, imageUrl, videoPath, videoStorageUrl, uploaded };
  } catch (error) {
    try {
      await removeMedia(uploaded);
    } catch (cleanupError) {
      throw new Error(`${error.message} Uploaded file cleanup failed: ${cleanupError.message}`);
    }
    throw error;
  }
}

document.getElementById("question-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!client || !isTeacher || !currentUser) {
    showStatus("question-message", "Only the teacher can manage Regents questions.", true);
    return;
  }
  const form = event.currentTarget;
  const data = new FormData(form);
  const imageFile = fileFromForm(data, "image");
  const videoFile = fileFromForm(data, "video");
  const videoUrl = data.get("explanation_url").trim();
  if (imageFile && (!imageFile.type.startsWith("image/") || imageFile.size > IMAGE_LIMIT)) {
    showStatus("question-message", "Choose an image file smaller than 15 MB.", true);
    return;
  }
  if (videoFile && (!["video/mp4", "video/webm"].includes(videoFile.type) || videoFile.size > VIDEO_LIMIT)) {
    showStatus("question-message", "Choose an MP4 or WebM video smaller than 100 MB.", true);
    return;
  }
  if (videoUrl) {
    try {
      if (new URL(videoUrl).protocol !== "https:") throw new Error("Video links must use HTTPS.");
    } catch (error) {
      showStatus("question-message", error.message || "Enter a valid HTTPS video link.", true);
      return;
    }
  }
  if (!data.get("explanation").trim() && !videoUrl && !videoFile
    && !(editingQuestion && editingQuestion.solution && editingQuestion.solution.explanation_video_path)) {
    showStatus("question-message", "Add a written or video explanation for students.", true);
    return;
  }

  const questionId = editingQuestion ? editingQuestion.id : newId();
  const oldImagePath = editingQuestion ? editingQuestion.image_path : null;
  const oldVideoPath = editingQuestion && editingQuestion.solution ? editingQuestion.solution.explanation_video_path : null;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  showStatus("question-message", "");
  let uploadedPaths = [];
  let saved = false;
  try {
    const media = await uploadQuestion(questionId, imageFile, videoFile, videoUrl, editingQuestion && editingQuestion.solution);
    uploadedPaths = media.uploaded;
    const questionRecord = {
      topic: data.get("topic").trim(),
      prompt: data.get("prompt").trim(),
      image_path: media.imagePath,
      image_url: media.imageUrl,
      choice_a: data.get("choice_a").trim(),
      choice_b: data.get("choice_b").trim(),
      choice_c: data.get("choice_c").trim(),
      choice_d: data.get("choice_d").trim(),
      created_at: editingQuestion ? editingQuestion.created_at : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const solutionRecord = {
      correct_option: data.get("correct_option"),
      explanation: data.get("explanation").trim(),
      explanation_video_url: videoUrl || null,
      explanation_video_path: media.videoPath,
      explanation_video_storage_url: media.videoStorageUrl,
      updated_at: new Date().toISOString(),
    };
    const batch = client.db.batch();
    batch.set(client.db.collection("questions").doc(questionId), questionRecord);
    batch.set(client.db.collection("question_solutions").doc(questionId), solutionRecord);
    await batch.commit();
    saved = true;
    closeQuestionEditor();
    const replacedPaths = [
      imageFile && oldImagePath && oldImagePath !== media.imagePath ? oldImagePath : null,
      (videoFile || videoUrl) && oldVideoPath && oldVideoPath !== media.videoPath ? oldVideoPath : null,
    ];
    try {
      await removeMedia(replacedPaths);
    } catch (cleanupError) {
      showStatus("questions-status", `Question saved, but old media cleanup failed: ${cleanupError.message}`, true);
    }
    await loadQuestions();
  } catch (error) {
    if (saved) {
      showStatus("questions-status", `Question saved, but the list could not refresh: ${error.message}`, true);
      closeQuestionEditor();
      return;
    }
    try {
      await removeMedia(uploadedPaths);
    } catch (cleanupError) {
      showStatus("question-message", `${error.message} Uploaded file cleanup failed: ${cleanupError.message}`, true);
      return;
    }
    showStatus("question-message", `Could not save this question: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

async function deleteQuestion(question, button) {
  if (!isTeacher || !window.confirm(`Delete "${question.topic || "this question"}"?`)) return;
  button.disabled = true;
  try {
    const solutionReference = client.db.collection("question_solutions").doc(question.id);
    const solutionSnapshot = await solutionReference.get();
    const solution = solutionSnapshot.exists ? solutionSnapshot.data() : null;
    const batch = client.db.batch();
    batch.delete(client.db.collection("questions").doc(question.id));
    if (solutionSnapshot.exists) batch.delete(solutionReference);
    await batch.commit();
    questions = questions.filter((item) => item.id !== question.id);
    renderQuestions();
    try {
      await removeMedia([question.image_path, solution && solution.explanation_video_path]);
    } catch (cleanupError) {
      showStatus("questions-status", `Question deleted, but its media could not be removed: ${cleanupError.message}`, true);
    }
  } catch (error) {
    button.disabled = false;
    showStatus("questions-status", `Could not delete the question: ${error.message}`, true);
  }
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function startChallenge() {
  const challengeItems = questions.filter(isValidMcq);
  if (!challengeItems.length) {
    showStatus("challenge-empty-message", "There are no questions yet. Check back after your teacher adds some.");
    return;
  }
  challenge = { active: true, items: shuffle(challengeItems), index: 0, correct: 0, answered: 0, skipped: 0 };
  document.getElementById("challenge-intro").hidden = true;
  document.getElementById("challenge-results").hidden = true;
  document.getElementById("challenge-session").hidden = false;
  renderChallengeQuestion();
}

function renderChallengeQuestion() {
  if (!challenge || challenge.index >= challenge.items.length) {
    finishChallenge();
    return;
  }
  const total = challenge.items.length;
  document.getElementById("challenge-progress-label").textContent = `Question ${challenge.index + 1} of ${total}`;
  document.getElementById("challenge-score-label").textContent = `${challenge.correct} correct · ${challenge.answered} answered`;
  document.getElementById("challenge-progress-bar").style.width = `${(challenge.index / total) * 100}%`;
  const question = challenge.items[challenge.index];
  const card = createQuestionCard(
    question,
    "challenge",
    (isCorrect) => {
      challenge.answered += 1;
      if (isCorrect) challenge.correct += 1;
      document.getElementById("challenge-score-label").textContent = `${challenge.correct} correct · ${challenge.answered} answered`;
    },
    () => advanceChallenge(true),
  );
  document.getElementById("challenge-question").replaceChildren(card);
}

function advanceChallenge(skipped) {
  if (!challenge) return;
  if (skipped) challenge.skipped += 1;
  challenge.index += 1;
  renderChallengeQuestion();
}

function finishChallenge() {
  if (!challenge) return;
  challenge.active = false;
  document.getElementById("challenge-session").hidden = true;
  document.getElementById("challenge-results").hidden = false;
  document.getElementById("challenge-progress-bar").style.width = "100%";
  document.getElementById("challenge-result-title").textContent = challenge.correct > 0 ? "Nice work." : "Good practice.";
  document.getElementById("challenge-result-summary").textContent =
    `${challenge.correct} correct · ${challenge.answered} answered · ${challenge.skipped} skipped`;
}

document.getElementById("start-challenge").addEventListener("click", startChallenge);
document.getElementById("play-again").addEventListener("click", startChallenge);

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value) {
  return new Uint8Array(value.match(/.{2}/g).map((part) => Number.parseInt(part, 16)));
}

async function hashPassword(password, salt) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error("Password protection is unavailable in this browser. Open the site over HTTPS.");
  }
  const key = await window.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const result = await window.crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: hexToBytes(salt),
    iterations: 210000,
    hash: "SHA-256",
  }, key, 256);
  return bytesToHex(new Uint8Array(result));
}

async function updateTeacherAuthForms() {
  const account = await getLocalRecord("settings", "teacher-account");
  document.getElementById("login-form").hidden = !account;
  document.getElementById("create-teacher-form").hidden = Boolean(account);
}

async function signInTeacher(username, password) {
  const account = await getLocalRecord("settings", "teacher-account");
  const normalizedUsername = username.trim().toLowerCase();
  if (!account || account.username !== normalizedUsername
    || await hashPassword(password, account.salt) !== account.passwordHash) {
    throw new Error("The username or password is incorrect.");
  }
  return { uid: LOCAL_TEACHER_UID, email: account.username };
}

function setAuthDialog(open) {
  const dialog = document.getElementById("auth-dialog");
  if (open && client) dialog.showModal();
  else if (open) setConnectionMessage("Browser storage is unavailable, so teacher sign-in cannot open.");
  else dialog.close();
}

document.getElementById("login-open").addEventListener("click", () => setAuthDialog(true));
document.getElementById("auth-close").addEventListener("click", () => setAuthDialog(false));
document.getElementById("auth-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) setAuthDialog(false);
});

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!client) return;
  const form = event.currentTarget;
  const data = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  showStatus("auth-message", "");
  try {
    const user = await client.auth.signInWithEmailAndPassword(data.get("username"), data.get("password"));
    syncAuth(user);
    form.reset();
    setAuthDialog(false);
  } catch (error) {
    showStatus("auth-message", `Could not sign in: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

document.getElementById("create-teacher-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!client) return;
  const form = event.currentTarget;
  const data = new FormData(form);
  const username = data.get("username").trim().toLowerCase();
  const password = data.get("password");
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  showStatus("setup-message", "");
  try {
    if (password !== data.get("confirm_password")) throw new Error("The passwords do not match.");
    if (await getLocalRecord("settings", "teacher-account")) {
      await updateTeacherAuthForms();
      throw new Error("A teacher login already exists in this browser.");
    }
    const salt = bytesToHex(window.crypto.getRandomValues(new Uint8Array(16)));
    const passwordHash = await hashPassword(password, salt);
    await client.db.collection("settings").doc("teacher-account").set({ username, salt, passwordHash });
    syncAuth({ uid: LOCAL_TEACHER_UID, email: username });
    form.reset();
    await updateTeacherAuthForms();
    setAuthDialog(false);
  } catch (error) {
    showStatus("setup-message", `Could not create the teacher login: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

document.getElementById("logout-button").addEventListener("click", async () => {
  if (!client) return;
  try {
    await client.auth.signOut();
    syncAuth(null);
  } catch (error) {
    setConnectionMessage(`Could not sign out: ${error.message}`);
  }
});

function syncAuth(user) {
  const wasTeacher = isTeacher;
  currentUser = user || null;
  isTeacher = Boolean(currentUser && currentUser.uid === LOCAL_TEACHER_UID);
  if (wasTeacher && !isTeacher) closeQuestionEditor();
  setTeacherControls();
  renderResources();
  renderQuestions();
  if (!currentUser) {
    setConnectionMessage("", false);
    return;
  }
  if (!isTeacher) setConnectionMessage("This account is not the teacher account. Students can use the site without signing in.");
  else setConnectionMessage("", false);
}

async function connectLocal() {
  try {
    await openLocalDatabase();
    client = {
      auth: {
        signInWithEmailAndPassword: signInTeacher,
        signOut: async () => {},
      },
      db: createLocalDatabaseAdapter(),
      storage: createLocalStorageAdapter(),
      answerCheck: checkLocalAnswer,
    };
    await Promise.all([loadResources(), loadQuestions()]);
    await updateTeacherAuthForms();
    syncAuth(null);
  } catch (error) {
    client = null;
    setConnectionMessage(`Could not open this browser's saved class content: ${error.message}`);
    setEmpty(document.getElementById("resource-list"), document.getElementById("resource-count"), "Materials unavailable", "Check that browser storage is enabled.");
    setEmpty(document.getElementById("questions-list"), document.getElementById("question-count"), "Questions unavailable", "Check that browser storage is enabled.");
  }
}

document.getElementById("resource-form").hidden = true;
document.getElementById("question-form").hidden = true;
document.getElementById("new-question-button").hidden = true;
document.getElementById("user-panel").hidden = true;
document.getElementById("challenge-session").hidden = true;
document.getElementById("challenge-results").hidden = true;
connectLocal();
