const shell = document.querySelector(".app-shell");
const toast = document.querySelector("#toast");
const selectedSourceLabel = document.querySelector("#selectedSourceLabel");
const sourceList = document.querySelector(".source-list");
const planProgress = document.querySelector("#planProgress");
const thread = document.querySelector("#thread");
const composer = document.querySelector("#composer");
const promptInput = document.querySelector("#promptInput");

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 1800);
}

function updatePlanProgress() {
  const checks = [...document.querySelectorAll(".check-row input")];
  const done = checks.filter((check) => check.checked).length;
  planProgress.textContent = `${done}/${checks.length}`;
  checks.forEach((check) => {
    check.closest(".check-row").classList.toggle("done", check.checked);
  });
}

document.querySelectorAll(".source-row").forEach((row) => {
  row.addEventListener("click", () => {
    document.querySelectorAll(".source-row").forEach((item) => item.classList.remove("active"));
    row.classList.add("active");
    selectedSourceLabel.textContent = `Using ${row.dataset.source}`;
    showToast(`${row.dataset.source} selected`);
  });
});

document.querySelector("#addSourceBtn").addEventListener("click", () => {
  const count = sourceList.querySelectorAll(".source-row").length + 1;
  const row = document.createElement("button");
  row.className = "source-row";
  row.type = "button";
  row.dataset.source = `New source ${count}`;
  row.innerHTML = `
    <span class="source-icon document">N</span>
    <span>
      <strong>New source ${count}</strong>
      <small>Local note added to this mock workspace</small>
    </span>
    <em>1</em>
  `;
  row.addEventListener("click", () => {
    document.querySelectorAll(".source-row").forEach((item) => item.classList.remove("active"));
    row.classList.add("active");
    selectedSourceLabel.textContent = `Using ${row.dataset.source}`;
    showToast(`${row.dataset.source} selected`);
  });
  sourceList.prepend(row);
  showToast("Source added");
});

document.querySelector("#syncBtn").addEventListener("click", () => {
  showToast("Workspace synced");
});

document.querySelector("#newTaskBtn").addEventListener("click", () => {
  promptInput.value = "Design the next React route from this mock";
  promptInput.focus();
  showToast("Draft task inserted");
});

document.querySelector("#voiceToggle").addEventListener("click", (event) => {
  event.currentTarget.classList.toggle("active");
  showToast(event.currentTarget.classList.contains("active") ? "Voice listening" : "Voice ready");
});

document.querySelectorAll(".mode").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".mode").forEach((mode) => mode.classList.remove("active"));
    button.classList.add("active");
    showToast(`${button.textContent} mode`);
  });
});

document.querySelectorAll(".artifact-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".artifact-tab").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`#${tab.dataset.tab}`).classList.add("active");
  });
});

document.querySelectorAll(".check-row input").forEach((check) => {
  check.addEventListener("change", updatePlanProgress);
});

document.querySelectorAll(".mobile-switcher button").forEach((button) => {
  button.addEventListener("click", () => {
    shell.dataset.mobilePanel = button.dataset.mobileTarget;
    document.querySelectorAll(".mobile-switcher button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
  });
});

document.querySelectorAll(".studio-tool").forEach((tool) => {
  tool.addEventListener("click", () => {
    document.querySelectorAll(".studio-tool").forEach((item) => item.classList.remove("active"));
    tool.classList.add("active");
    showToast(`${tool.querySelector("strong").textContent} selected`);
  });
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = promptInput.value.trim();
  if (!text) {
    showToast("Type a request first");
    return;
  }

  const userMessage = document.createElement("article");
  userMessage.className = "message user";
  userMessage.innerHTML = `<span>Yao</span><p></p>`;
  userMessage.querySelector("p").textContent = text;
  thread.append(userMessage);

  const assistantMessage = document.createElement("article");
  assistantMessage.className = "message assistant";
  assistantMessage.innerHTML =
    "<span>Octos</span><p>Added this as a workspace task. The right rail now treats it as an artifact candidate.</p>";
  thread.append(assistantMessage);

  promptInput.value = "";
  thread.scrollTop = thread.scrollHeight;
  showToast("Message added");
});

document.querySelector("#attachBtn").addEventListener("click", () => {
  showToast("Attachment slot opened");
});

updatePlanProgress();
