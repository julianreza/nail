export const NOW = Date.UTC(2026, 9, 22, 0, 0, 0);

export function tokensFixture() {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "fixture_account" } };
  return {
    access_token: `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
    refresh_token: "fixture_refresh_do_not_log",
    expires_in: 3600,
  };
}

export function catalogFixture() {
  return { models: [
    { slug: "fixture-model", display_name: "Fixture model", visibility: "list", priority: 1 },
    { slug: "hidden-model", display_name: "Hidden", visibility: "hide", priority: 0 },
  ] };
}
