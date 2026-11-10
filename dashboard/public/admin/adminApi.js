(function () {
  "use strict";
  async function request(url, body) {
    const response = await fetch(url, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (response.status === 401) {
      window.location.replace("/login");
      throw new Error("Prijava je istekla. Prijavi se ponovno.");
    }
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Zahtjev nije uspio. Pokušaj ponovno.");
    return data;
  }
  function searchText(value) {
    return String(value).toLocaleLowerCase("hr").normalize("NFD").replace(/\p{M}/gu, "").replaceAll("đ", "d");
  }
  function matches(value, query) {
    const text = searchText(value);
    return (searchText(query).match(/\S+/g) || []).every(term => text.includes(term));
  }
  globalThis.IoTAdmin = { request, matches };
})();
