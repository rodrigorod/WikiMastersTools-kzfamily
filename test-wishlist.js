// Just a scratch pad to think about the loop
async function fetchAllWishlistIds() {
  let page = 0;
  let hasMore = true;
  const ids = new Set();
  
  while (hasMore) {
    const res = await fetch(`/api/cards?page=${page}&sort=rarity&wishlist=1`);
    const data = await res.json();
    
    // Some endpoints might return wishlistCardIds directly with all of them
    if (page === 0 && data.wishlistCardIds && data.wishlistCardIds.length > 0) {
      data.wishlistCardIds.forEach(id => ids.add(id));
      // if it contains all, maybe we don't need to paginate?
    }
    
    if (data.cards) {
      data.cards.forEach(c => ids.add(c.id));
    }
    
    hasMore = data.searchHasMore === true;
    page++;
  }
  return ids;
}
