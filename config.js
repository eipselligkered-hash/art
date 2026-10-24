// App configuration. Same Supabase project as the Chores app (same login); Art's data lives in the art_* tables.
// The anon key is safe to publish (row-level security protects the data). NEVER put the service_role key here.
window.ART_CONFIG = {
  backend: 'auto',                       // 'auto' = Supabase when the two values below are filled in, otherwise local mock
  supabaseUrl: 'https://rwbiizjwvyssdyxjuqan.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3Ymlpemp3dnlzc2R5eGp1cWFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzMTc0MDMsImV4cCI6MjEwNzg5MzQwM30.E5QFlaM434SRXo8ygcT_gmIfI2ntxQhxR20JAaaiOWk',
  dog: { name: 'Art', about: 'White-and-black lurcher · born June 2020', born: '2020-06' },
  vet: { name: 'Dublin Bay Vets', address: '5 Main Street, Clongriffin, Dublin 13', phone: '01 539 2330', tel: '+35315392330' },
  choresUrl: 'https://eipselligkered-hash.github.io/chores/',
};
