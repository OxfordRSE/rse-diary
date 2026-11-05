// Progressive enhancement only: every behaviour here has a plain-link/form fallback.

function scrollCalendarsToToday() {
  for (const wrap of document.querySelectorAll<HTMLElement>(".cal-wrap")) {
    // Scroll only the wrapper (scrollIntoView would also scroll the page).
    const target = wrap.querySelector<HTMLElement>("td.selected, td.today");
    if (!target) {
      wrap.scrollLeft = wrap.scrollWidth;
      continue;
    }
    const w = wrap.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    wrap.scrollLeft += t.left - w.left - w.width / 2;
    wrap.scrollTop += t.top - w.top - w.height / 2;
  }
}

async function showDay(href: string, push: boolean) {
  const url = new URL(href, location.href);
  url.searchParams.set("fragment", "day");
  const res = await fetch(url, { headers: { accept: "text/html" } });
  if (!res.ok) throw new Error(String(res.status));
  const current = document.getElementById("day");
  if (!current) throw new Error("no #day");
  current.outerHTML = await res.text();
  url.searchParams.delete("fragment");
  if (push) history.pushState({ day: true }, "", url);
  const day = url.searchParams.get("day");
  document.querySelectorAll(".cal td.selected").forEach((td) => td.classList.remove("selected"));
  if (day) document.querySelector(`.cal td[data-date="${day}"]`)?.classList.add("selected");
  const dayInput = document.querySelector<HTMLInputElement>('form input[name="day"]');
  if (dayInput && day) dayInput.value = day;
}

function interceptDayLinks() {
  if (!document.getElementById("day")) return; // only the overview swaps in place
  document.addEventListener("click", (ev) => {
    const a = (ev.target as Element).closest<HTMLAnchorElement>(".cal td a[href^='/?']");
    if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    showDay(a.href, true).catch(() => (location.href = a.href));
  });
  window.addEventListener("popstate", () => {
    showDay(location.href, false).catch(() => location.reload());
  });
}

scrollCalendarsToToday();
interceptDayLinks();
