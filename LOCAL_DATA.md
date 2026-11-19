# Local browser storage

This site has no Firebase or other backend. The teacher creates one username and password the first time, then materials, questions, and attachments are saved in that browser's IndexedDB.

- Use the same Chrome profile and published site address to keep seeing the saved content.
- Students using another device or browser will not see the teacher's local changes.
- Data saved from a `file://` preview does not move to the published website.
- Clearing the browser's site data can erase saved materials and the teacher login.
- The password is stored as a salted hash, but this is only a basic local lock. It does not securely protect content from someone with access to the browser or developer tools.

Students can review and answer questions in the same browser without signing in. Use this mode for a personal or single-device site; sharing content across devices requires a hosted backend.
