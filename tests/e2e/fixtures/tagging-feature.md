## Feature Request: Add Tagging Support

Add the ability to tag bookmarks with multiple tags for better organization.

### Acceptance Criteria

1. Tags table with `id`, `name`, `created_at` columns
2. Many-to-many join table `bookmark_tags`
3. REST endpoints: `GET /tags`, `POST /tags`, `DELETE /tags/:id`
4. `POST /bookmarks` and `PUT /bookmarks/:id` accept optional `tag_ids[]`
5. `GET /bookmarks` supports optional `?tag=<name>` filter
6. Tag cloud component in the UI showing all tags with bookmark counts
7. Playwright tests covering: create tag, tag a bookmark, filter by tag, delete tag

### Technical Notes

- Use SQLite for the database (already in place)
- Add migration script in `migrations/` directory
- Follow the existing Hono route pattern in `src/routes/`
- Use Playwright for all new tests (config already in `playwright.config.ts`)
