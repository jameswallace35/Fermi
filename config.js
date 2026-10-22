// Optional settings for this deployment. Edit and commit.
//
// apiUrl: the address of a deployed Fermi accounts API (a Cloudflare Worker,
// see README "Accounts"). With it set, players can create a username and
// password and their history follows them between devices. Leave it empty to
// run without accounts (results stay in the browser; backup codes still work).
window.FERMI_CONFIG = Object.assign({ apiUrl: 'https://fermi-api.thejamescwallace.workers.dev' }, window.FERMI_CONFIG || {});
