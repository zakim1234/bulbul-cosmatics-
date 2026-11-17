import client from './client.js';

// Lists are shown as one long page (no Prev/Next): this reads every page of
// a paginated list endpoint in turn. `onChunk(rowsSoFar, response)` is called
// after each part so the first rows show straight away while the rest load;
// `isStale()` returning true (a newer search started) stops it.
export async function fetchAll(url, params = {}, { limit = 200, onChunk, isStale } = {}) {
  let page = 1;
  let rows = [];
  let res;
  do {
    res = await client.get(url, { params: { ...params, page, limit } });
    if (isStale?.()) return null;
    rows = rows.concat(res.data.data);
    onChunk?.(rows, res.data);
    page += 1;
  } while (page <= (res.data.pagination?.pages || 1));
  return { ...res.data, data: rows, pagination: { ...res.data.pagination, page: 1, pages: 1 } };
}
