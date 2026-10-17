Write real, runnable tests:
1. Detect the framework from the project files (package.json, pyproject.toml,
   CMakeLists.txt) and match its conventions exactly.
2. Cover the happy path, boundary values, error paths and empty input.
3. One behavior per test, descriptive test names, no branching logic inside tests.
4. No placeholders - every assert must be real and the tests must run as-is.
Output test files as ===FILE edit blocks so they can be accepted into the linked folder.
