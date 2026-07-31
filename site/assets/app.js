(() => {
  "use strict";

  const root = document.documentElement;
  root.classList.add("js");

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  function listen(target, eventName, handler, options) {
    if (target) target.addEventListener(eventName, handler, options);
  }

  function initHeader() {
    const header = document.querySelector("[data-site-header]");
    const toggle = document.querySelector("[data-nav-toggle]");
    const navigation = document.querySelector("[data-primary-nav]");

    if (!header) return;

    const updateHeader = () => {
      header.classList.toggle("is-scrolled", window.scrollY > 12);
    };

    const closeNavigation = ({ restoreFocus = false } = {}) => {
      if (!toggle || !navigation) return;
      toggle.setAttribute("aria-expanded", "false");
      navigation.classList.remove("is-open");
      header.classList.remove("is-open");
      document.body.classList.remove("nav-open");
      if (restoreFocus) toggle.focus();
    };

    const openNavigation = () => {
      if (!toggle || !navigation) return;
      toggle.setAttribute("aria-expanded", "true");
      navigation.classList.add("is-open");
      header.classList.add("is-open");
      document.body.classList.add("nav-open");
    };

    updateHeader();
    listen(window, "scroll", updateHeader, { passive: true });

    listen(toggle, "click", () => {
      const isOpen = toggle.getAttribute("aria-expanded") === "true";
      if (isOpen) closeNavigation();
      else openNavigation();
    });

    navigation?.querySelectorAll("a").forEach((link) => {
      listen(link, "click", () => closeNavigation());
    });

    listen(document, "click", (event) => {
      if (
        toggle?.getAttribute("aria-expanded") === "true" &&
        !header.contains(event.target)
      ) {
        closeNavigation();
      }
    });

    listen(document, "keydown", (event) => {
      if (
        event.key === "Escape" &&
        toggle?.getAttribute("aria-expanded") === "true"
      ) {
        closeNavigation({ restoreFocus: true });
      }
    });

    listen(window, "resize", () => {
      if (window.innerWidth > 900) closeNavigation();
    });
  }

  function initToast() {
    const toast = document.querySelector("[data-toast]");
    let timer = 0;

    return (message, isError = false) => {
      if (!toast) return;
      window.clearTimeout(timer);
      toast.textContent = message;
      toast.classList.toggle("is-error", isError);
      toast.classList.add("is-visible");
      timer = window.setTimeout(() => {
        toast.classList.remove("is-visible");
      }, 2200);
    };
  }

  async function copyText(text) {
    if (!text) throw new Error("没有可复制的内容");

    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("浏览器未允许复制");
  }

  function initCopy(showToast) {
    document.querySelectorAll("[data-copy-target]").forEach((button) => {
      listen(button, "click", async () => {
        const selector = button.getAttribute("data-copy-target");
        const target = selector ? document.querySelector(selector) : null;
        const text = target?.textContent?.trim() || "";
        const label = button.querySelector(".copy-label");
        const originalLabel = label?.textContent || "";

        try {
          await copyText(text);
          showToast("已复制到剪贴板");
          button.dataset.copyState = "success";
          if (label) label.textContent = "已复制";
        } catch (error) {
          const detail =
            error instanceof Error && error.message
              ? `：${error.message}`
              : "";
          showToast(`复制失败${detail}`, true);
          button.dataset.copyState = "error";
        }

        window.setTimeout(() => {
          delete button.dataset.copyState;
          if (label) label.textContent = originalLabel;
        }, 1800);
      });
    });
  }

  function initTabs() {
    document.querySelectorAll("[data-tabs]").forEach((tabsRoot) => {
      const tabList = tabsRoot.querySelector('[role="tablist"]');
      const tabs = [...tabsRoot.querySelectorAll('[role="tab"]')];
      const panels = [...tabsRoot.querySelectorAll('[role="tabpanel"]')];

      if (!tabList || !tabs.length) return;

      const activate = (tab, { focus = false } = {}) => {
        const targetId = tab.getAttribute("aria-controls");
        tabs.forEach((candidate) => {
          const selected = candidate === tab;
          candidate.setAttribute("aria-selected", String(selected));
          candidate.tabIndex = selected ? 0 : -1;
        });
        panels.forEach((panel) => {
          panel.hidden = panel.id !== targetId;
        });
        if (focus) tab.focus();
      };

      const selected =
        tabs.find((tab) => tab.getAttribute("aria-selected") === "true") ||
        tabs[0];
      activate(selected);

      tabs.forEach((tab) => {
        listen(tab, "click", () => activate(tab));
        listen(tab, "keydown", (event) => {
          const currentIndex = tabs.indexOf(tab);
          let nextIndex = currentIndex;

          if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            nextIndex = (currentIndex + 1) % tabs.length;
          } else if (
            event.key === "ArrowLeft" ||
            event.key === "ArrowUp"
          ) {
            nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
          } else if (event.key === "Home") {
            nextIndex = 0;
          } else if (event.key === "End") {
            nextIndex = tabs.length - 1;
          } else {
            return;
          }

          event.preventDefault();
          activate(tabs[nextIndex], { focus: true });
        });
      });
    });
  }

  function initAccordions() {
    document.querySelectorAll("[data-accordion]").forEach((accordion) => {
      const buttons = [
        ...accordion.querySelectorAll("button[aria-controls]"),
      ];

      buttons.forEach((button) => {
        const panelId = button.getAttribute("aria-controls");
        const panel = panelId ? document.getElementById(panelId) : null;
        if (!panel) return;

        panel.hidden = button.getAttribute("aria-expanded") !== "true";

        listen(button, "click", () => {
          const willOpen = button.getAttribute("aria-expanded") !== "true";

          buttons.forEach((candidate) => {
            const candidateId = candidate.getAttribute("aria-controls");
            const candidatePanel = candidateId
              ? document.getElementById(candidateId)
              : null;
            const isTarget = candidate === button && willOpen;
            candidate.setAttribute("aria-expanded", String(isTarget));
            if (candidatePanel) candidatePanel.hidden = !isTarget;
          });
        });
      });
    });
  }

  function parseCatalogData() {
    const element = document.querySelector("[data-catalog-json]");
    if (!element) return [];

    try {
      const value = element.getAttribute("data-catalog-json") || "[]";
      const data = JSON.parse(value);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  function initCatalog(showToast) {
    const cards = [...document.querySelectorAll("[data-catalog-card]")];
    if (!cards.length) return;

    const search = document.querySelector("[data-catalog-search]");
    const filters = [
      ...document.querySelectorAll("[data-category-filter]"),
    ];
    const profiles = [...document.querySelectorAll("[data-profile]")];
    const tray = document.querySelector("[data-selection-tray]");
    const count = document.querySelector("[data-selection-count]");
    const output = document.querySelector("#selection-output");
    const empty = document.querySelector("[data-catalog-empty]");
    const clear = document.querySelector("[data-clear-selection]");
    const catalogData = parseCatalogData();
    const names = new Map(
      catalogData.map((item) => [String(item.id), String(item.name)]),
    );
    let activeCategory = "all";

    const normalize = (value) =>
      String(value || "")
        .trim()
        .toLocaleLowerCase();

    const checkboxes = cards
      .map((card) => card.querySelector('input[type="checkbox"]'))
      .filter(Boolean);

    const selectedIds = () =>
      checkboxes.filter((box) => box.checked).map((box) => box.value);

    const updateSelection = () => {
      const ids = selectedIds();
      cards.forEach((card) => {
        const checkbox = card.querySelector('input[type="checkbox"]');
        card.classList.toggle("is-selected", Boolean(checkbox?.checked));
      });

      if (count) count.textContent = `${ids.length} 个已选择`;
      if (output) {
        output.textContent = ids.length
          ? ids
              .map((id) => `$${id}${names.has(id) ? ` · ${names.get(id)}` : ""}`)
              .join("  ")
          : "尚未选择能力";
      }
      tray?.classList.toggle("is-active", ids.length > 0);
    };

    const applyFilters = () => {
      const query = normalize(search?.value);
      let visible = 0;

      cards.forEach((card) => {
        const matchesCategory =
          activeCategory === "all" ||
          card.dataset.category === activeCategory;
        const matchesSearch =
          !query || normalize(card.dataset.search).includes(query);
        const show = matchesCategory && matchesSearch;
        card.hidden = !show;
        if (show) visible += 1;
      });

      if (empty) empty.hidden = visible > 0;
    };

    const setCategory = (button, { focus = false } = {}) => {
      activeCategory = button.dataset.categoryFilter || "all";
      filters.forEach((candidate) => {
        const selected = candidate === button;
        candidate.setAttribute("aria-selected", String(selected));
        candidate.tabIndex = selected ? 0 : -1;
      });
      if (focus) button.focus();
      applyFilters();
    };

    const findByTerms = (terms) =>
      checkboxes.filter((checkbox) => {
        const id = normalize(checkbox.value);
        return terms.some(
          (term) =>
            id === term ||
            id.endsWith(`:${term}`) ||
            id.endsWith(`/${term}`) ||
            id.includes(term),
        );
      });

    const profileTerms = {
      core: ["think", "plan", "work", "test", "review"],
      delivery: [
        "sprint",
        "checkpoint",
        "handoff",
        "test",
        "review",
      ],
      memory: [
        "memory",
        "learn",
        "compound",
        "continuous-learning",
        "instinct",
      ],
    };

    checkboxes.forEach((checkbox) => {
      listen(checkbox, "change", () => {
        profiles.forEach((profile) =>
          profile.setAttribute("aria-pressed", "false"),
        );
        updateSelection();
      });
    });

    cards.forEach((card) => {
      const sourceLink = card.querySelector("[data-card-source]");
      listen(sourceLink, "click", (event) => event.stopPropagation());
      listen(sourceLink, "keydown", (event) => event.stopPropagation());
    });

    listen(search, "input", applyFilters);

    filters.forEach((button) => {
      listen(button, "click", () => setCategory(button));
      listen(button, "keydown", (event) => {
        const currentIndex = filters.indexOf(button);
        let nextIndex = currentIndex;

        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          nextIndex = (currentIndex + 1) % filters.length;
        } else if (
          event.key === "ArrowLeft" ||
          event.key === "ArrowUp"
        ) {
          nextIndex = (currentIndex - 1 + filters.length) % filters.length;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = filters.length - 1;
        } else {
          return;
        }

        event.preventDefault();
        setCategory(filters[nextIndex], { focus: true });
      });
    });

    profiles.forEach((button) => {
      button.setAttribute("aria-pressed", "false");
      listen(button, "click", () => {
        const profile = button.dataset.profile || "";
        const targets =
          profile === "full"
            ? checkboxes
            : findByTerms(profileTerms[profile] || []);
        const targetSet = new Set(targets);

        checkboxes.forEach((checkbox) => {
          checkbox.checked = targetSet.has(checkbox);
        });
        profiles.forEach((candidate) => {
          candidate.setAttribute(
            "aria-pressed",
            String(candidate === button),
          );
        });
        updateSelection();

        if (!targets.length) {
          showToast("当前构建中没有匹配此预设的能力", true);
        }
      });
    });

    listen(clear, "click", () => {
      checkboxes.forEach((checkbox) => {
        checkbox.checked = false;
      });
      profiles.forEach((profile) =>
        profile.setAttribute("aria-pressed", "false"),
      );
      updateSelection();
      search?.focus();
    });

    const initiallySelected =
      filters.find(
        (button) => button.getAttribute("aria-selected") === "true",
      ) || filters[0];
    if (initiallySelected) setCategory(initiallySelected);
    updateSelection();
  }

  function initReveal() {
    const singles = [
      ...document.querySelectorAll(
        ".section-heading, .hero-copy, .hero-panel, .page-hero .shell, .layer-summary, .final-cta-inner",
      ),
    ];
    const groups = [
      ...document.querySelectorAll(
        ".proof-strip, .layer-grid, .feature-grid, .compare-grid, .capability-grid, .update-grid, .profile-list, .catalog-grid, .platform-grid, .control-grid, .source-grid, .status-grid",
      ),
    ];
    const targets = [...new Set([...singles, ...groups])];

    singles.forEach((element) => element.classList.add("reveal"));
    groups.forEach((element) => element.classList.add("reveal-group"));

    if (reduceMotion || !("IntersectionObserver" in window)) {
      targets.forEach((element) => element.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      {
        rootMargin: "0px 0px -8% 0px",
        threshold: 0.08,
      },
    );

    targets.forEach((element) => observer.observe(element));
  }

  const showToast = initToast();
  initHeader();
  initCopy(showToast);
  initTabs();
  initAccordions();
  initCatalog(showToast);
  initReveal();
})();
