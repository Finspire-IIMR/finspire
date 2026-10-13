/* Finspire site settings. Nothing here is secret: a Google OAuth client id and a Drive API key restricted to this
   site's address are designed to be public. See SETUP.md for how to fill these in. */
window.FINSPIRE_CONFIG = {
  googleClientId: "672169753817-74im681f13llqarfqajv333j9egm7kva.apps.googleusercontent.com",  // OAuth 2.0 Web client (Google Cloud project "Finspire website")
  allowedDomain: "iimranchi.ac.in",   // only these Google accounts may sign in
  driveApiKey: "",                    // optional: lets the Library list folders shared "anyone with the link"
  admins: [],                         // plain emails allowed to use Edit mode (prefer adminHashes in a public repo)
  adminHashes: [                      // SHA-256 of each admin's lower-case email (ask the site maintainer to add one)
    "af437f26c4a57fef2b0458fbecef3c24c75f5a327beded63b63c81120e14117c",
    "d888a4c1fb9008f91e705a3b3cb391dee51f9617c0c9198f434c67da83ba94ba"
  ],
  github: { owner: "Finspire-IIMR", repo: "finspire", branch: "main" },  // where Edit mode saves data/site-data.json
  siteUrl: "https://finspire-iimr.github.io/finspire/",
  marketsPollSeconds: 15,
  newsPollSeconds: 180
};
