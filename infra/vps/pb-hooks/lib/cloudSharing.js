function setSharing(row, on, newSlug) {
  row.set('visibility', on ? 'link' : 'private');
  row.set('share_slug', on ? newSlug() : '');
}

module.exports = { setSharing };
