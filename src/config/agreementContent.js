/**
 * Agreement content — clauses, disclaimer, doc strings, service catalog in
 * en/te/hi. PORTED FROM ../framedrops/src/data/agreementContent.ts.
 * KEEP IN SYNC with the FE source until a shared package exists. The server
 * PDF renderer (agreement-pdf.service.js) reads clause/disclaimer/doc-string
 * text from here so generated PDFs match the on-screen document exactly.
 */

/**
 * Multilingual content library for the Photography Agreement Builder.
 *
 * The agreement contains TWO kinds of text:
 *   1. Static / template text — section titles, field labels, service names,
 *      standard legal clauses. These are pre-translated here in en / te / hi.
 *   2. User-entered data — customer name, custom clauses, notes, venue.
 *      These stay exactly as the photographer typed them (never machine-translated).
 *
 * The per-agreement language picker selects which `AgreementLang` to render in
 * the PDF and on the client acceptance page. Toggling a predefined clause inserts
 * the correct-language body automatically (see `PREDEFINED_CLAUSES`).
 *
 * NOTE (backend follow-up): the real server-side PDF generator must embed
 * Noto Sans Telugu + Noto Sans Devanagari fonts, or te/hi text renders as boxes.
 * The in-app preview loads these via Google Fonts (see index.html).
 */



/** The 3 languages the agreement PDF can be generated in. */
export const AGREEMENT_LANGS = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'te', label: 'Telugu', native: 'తెలుగు' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी' },
]

/** Font family to apply to preview/PDF text per language (Latin fonts box-out Indic scripts). */
export const LANG_FONT = {
  en: "'Inter', 'Roboto', sans-serif",
  te: "'Noto Sans Telugu', 'Inter', sans-serif",
  hi: "'Noto Sans Devanagari', 'Inter', sans-serif",
}

/* ──────────────────────────────────────────────────────────────────────────
 * Event types
 * ────────────────────────────────────────────────────────────────────────── */


export const EVENT_TYPES = [
  { value: 'wedding', label: { en: 'Wedding', te: 'వివాహం', hi: 'शादी' } },
  { value: 'engagement', label: { en: 'Engagement', te: 'నిశ్చితార్థం', hi: 'सगाई' } },
  { value: 'birthday', label: { en: 'Birthday', te: 'పుట్టినరోజు', hi: 'जन्मदिन' } },
  { value: 'maternity', label: { en: 'Maternity', te: 'మెటర్నిటీ', hi: 'मातृत्व' } },
  { value: 'corporate', label: { en: 'Corporate Event', te: 'కార్పొరేట్ ఈవెంట్', hi: 'कॉर्पोरेट इवेंट' } },
  { value: 'baby_shower', label: { en: 'Baby Shower', te: 'సీమంతం', hi: 'गोद भराई' } },
  { value: 'other', label: { en: 'Other', te: 'ఇతరం', hi: 'अन्य' } },
]

/* ──────────────────────────────────────────────────────────────────────────
 * Services — categorised checklist
 * ────────────────────────────────────────────────────────────────────────── */



export const SERVICE_CATEGORIES = [
  {
    id: 'photography',
    icon: 'mdi-camera-outline',
    color: '#7c3aed', // violet
    tint: '#F3EEFF',
    title: { en: 'Photography', te: 'ఫోటోగ్రఫీ', hi: 'फ़ोटोग्राफ़ी' },
    items: [
      { id: 'trad_photo', label: { en: 'Traditional Photography', te: 'సాంప్రదాయ ఫోటోగ్రఫీ', hi: 'पारंपरिक फ़ोटोग्राफ़ी' } },
      { id: 'candid_photo', label: { en: 'Candid Photography', te: 'క్యాండిడ్ ఫోటోగ్రఫీ', hi: 'कैंडिड फ़ोटोग्राफ़ी' } },
      { id: 'addl_photographer', label: { en: 'Additional Photographer', te: 'అదనపు ఫోటోగ్రాఫర్', hi: 'अतिरिक्त फ़ोटोग्राफ़र' } },
      { id: 'family_portrait', label: { en: 'Family Portrait Coverage', te: 'కుటుంబ పోర్ట్రెయిట్ కవరేజ్', hi: 'पारिवारिक पोर्ट्रेट कवरेज' } },
      { id: 'pre_wedding', label: { en: 'Pre-Wedding Shoot', te: 'ప్రీ-వెడ్డింగ్ షూట్', hi: 'प्री-वेडिंग शूट' } },
      { id: 'post_wedding', label: { en: 'Post-Wedding Shoot', te: 'పోస్ట్-వెడ్డింగ్ షూట్', hi: 'पोस्ट-वेडिंग शूट' } },
      { id: 'engagement_shoot', label: { en: 'Engagement Shoot', te: 'నిశ్చితార్థం షూట్', hi: 'सगाई शूट' } },
      { id: 'reception_cov', label: { en: 'Reception Coverage', te: 'రిసెప్షన్ కవరేజ్', hi: 'रिसेप्शन कवरेज' } },
      { id: 'haldi_cov', label: { en: 'Haldi Coverage', te: 'హల్దీ కవరేజ్', hi: 'हल्दी कवरेज' } },
      { id: 'mehendi_cov', label: { en: 'Mehendi Coverage', te: 'మెహందీ కవరేజ్', hi: 'मेहंदी कवरेज' } },
      { id: 'sangeet_cov', label: { en: 'Sangeet Coverage', te: 'సంగీత్ కవరేజ్', hi: 'संगीत कवरेज' } },
      { id: 'maternity_shoot', label: { en: 'Maternity / Newborn Shoot', te: 'మెటర్నిటీ / నవజాత శిశు షూట్', hi: 'मैटरनिटी / नवजात शूट' } },
      { id: 'birthday_cov', label: { en: 'Birthday Event Coverage', te: 'పుట్టినరోజు ఈవెంట్ కవరేజ్', hi: 'जन्मदिन इवेंट कवरेज' } },
      { id: 'housewarming_cov', label: { en: 'Housewarming Coverage', te: 'గృహప్రవేశం కవరేజ్', hi: 'गृहप्रवेश कवरेज' } },
      { id: 'corporate_cov', label: { en: 'Corporate Event Coverage', te: 'కార్పొరేట్ ఈవెంట్ కవరేజ్', hi: 'कॉर्पोरेट इवेंट कवरेज' } },
      { id: 'product_photo', label: { en: 'Product Photography', te: 'ప్రోడక్ట్ ఫోటోగ్రఫీ', hi: 'प्रोडक्ट फ़ोटोग्राफ़ी' } },
      { id: 'fashion_photo', label: { en: 'Fashion Photography', te: 'ఫ్యాషన్ ఫోటోగ్రఫీ', hi: 'फ़ैशन फ़ोटोग्राफ़ी' } },
      { id: 'destination_cov', label: { en: 'Destination Wedding Coverage', te: 'డెస్టినేషన్ వెడ్డింగ్ కవరేజ్', hi: 'डेस्टिनेशन वेडिंग कवरेज' } },
    ],
  },
  {
    id: 'videography',
    icon: 'mdi-video-outline',
    color: '#0EA5E9', // sky
    tint: '#E0F2FE',
    title: { en: 'Videography', te: 'వీడియోగ్రఫీ', hi: 'वीडियोग्राफ़ी' },
    items: [
      { id: 'trad_video', label: { en: 'Traditional Videography', te: 'సాంప్రదాయ వీడియోగ్రఫీ', hi: 'पारंपरिक वीडियोग्राफ़ी' } },
      { id: 'cinematic_video', label: { en: 'Cinematic Videography', te: 'సినిమాటిక్ వీడియోగ్రఫీ', hi: 'सिनेमैटिक वीडियोग्राफ़ी' } },
      { id: 'drone', label: { en: 'Drone Coverage', te: 'డ్రోన్ కవరేజ్', hi: 'ड्रोन कवरेज' } },
      { id: 'multi_cam', label: { en: 'Multi Camera Coverage', te: 'మల్టీ కెమెరా కవరేజ్', hi: 'मल्टी कैमरा कवरेज' } },
      { id: 'live_mixing', label: { en: 'Live Video Mixing', te: 'లైవ్ వీడియో మిక్సింగ్', hi: 'लाइव वीडियो मिक्सिंग' } },
      { id: '360_video', label: { en: '360° / VR Coverage', te: '360° / VR కవరేజ్', hi: '360° / VR कवरेज' } },
      { id: 'wedding_trailer', label: { en: 'Wedding Trailer', te: 'వెడ్డింగ్ ట్రైలర్', hi: 'वेडिंग ट्रेलर' } },
      { id: 'highlight_film', label: { en: 'Highlight Film', te: 'హైలైట్ ఫిల్మ్', hi: 'हाइलाइट फ़िल्म' } },
      { id: 'documentary_edit', label: { en: 'Documentary Edit', te: 'డాక్యుమెంటరీ ఎడిట్', hi: 'डॉक्यूमेंट्री एडिट' } },
      { id: 'short_film_edit', label: { en: 'Short Film Edit', te: 'షార్ట్ ఫిల్మ్ ఎడిట్', hi: 'शॉर्ट फ़िल्म एडिट' } },
      { id: 'gimbal_cov', label: { en: 'Gimbal Coverage', te: 'గింబల్ కవరేజ్', hi: 'गिम्बल कवरेज' } },
      { id: 'crane_cov', label: { en: 'Crane / Jimmy Jib Coverage', te: 'క్రేన్ / జిమ్మీ జిబ్ కవరేజ్', hi: 'क्रेन / जिमी जिब कवरेज' } },
      { id: 'multiday_cov', label: { en: 'Multi-Day Event Coverage', te: 'మల్టీ-డే ఈవెంట్ కవరేజ్', hi: 'मल्टी-डे इवेंट कवरेज' } },
    ],
  },
  {
    id: 'albums',
    icon: 'mdi-book-open-page-variant-outline',
    color: '#D97706', // amber
    tint: '#FEF3C7',
    title: { en: 'Albums & Prints', te: 'ఆల్బమ్‌లు & ప్రింట్‌లు', hi: 'एल्बम और प्रिंट' },
    items: [
      { id: 'wedding_album', label: { en: 'Wedding Album', te: 'వివాహ ఆల్బమ్', hi: 'शादी एल्बम' } },
      { id: 'premium_album', label: { en: 'Premium Album', te: 'ప్రీమియం ఆల్బమ్', hi: 'प्रीमियम एल्बम' } },
      { id: 'acrylic_album', label: { en: 'Acrylic Album', te: 'యాక్రిలిక్ ఆల్బమ్', hi: 'एक्रिलिक एल्बम' } },
      { id: 'parent_album', label: { en: 'Parent Album', te: 'పేరెంట్ ఆల్బమ్', hi: 'पैरेंट एल्बम' } },
      { id: 'mini_album', label: { en: 'Mini / Pocket Album', te: 'మినీ / పాకెట్ ఆల్బమ్', hi: 'मिनी / पॉकेट एल्बम' } },
      { id: 'photo_frames', label: { en: 'Framed Prints', te: 'ఫ్రేమ్ చేసిన ప్రింట్‌లు', hi: 'फ़्रेम किए प्रिंट' } },
      { id: 'canvas_prints', label: { en: 'Canvas Prints', te: 'క్యాన్వాస్ ప్రింట్‌లు', hi: 'कैनवास प्रिंट' } },
      { id: 'wall_frames', label: { en: 'Wall Frames', te: 'వాల్ ఫ్రేమ్‌లు', hi: 'वॉल फ़्रेम' } },
      { id: 'coffee_table', label: { en: 'Coffee Table Album', te: 'కాఫీ టేబుల్ ఆల్బమ్', hi: 'कॉफ़ी टेबल एल्बम' } },
      { id: 'magazine_album', label: { en: 'Magazine Style Album', te: 'మ్యాగజైన్ స్టైల్ ఆల్బమ్', hi: 'मैगज़ीन स्टाइल एल्बम' } },
      { id: 'photo_book', label: { en: 'Photo Book', te: 'ఫోటో బుక్', hi: 'फ़ोटो बुक' } },
      { id: 'calendar_print', label: { en: 'Photo Calendar', te: 'ఫోటో క్యాలెండర్', hi: 'फ़ोटो कैलेंडर' } },
      { id: 'thankyou_cards', label: { en: 'Thank You Cards', te: 'థాంక్ యూ కార్డ్‌లు', hi: 'थैंक यू कार्ड' } },
    ],
  },
  {
    id: 'deliverables',
    icon: 'mdi-package-variant-closed',
    color: '#16A34A', // green
    tint: '#DCFCE7',
    title: { en: 'Digital Deliverables', te: 'డిజిటల్ డెలివరబుల్స్', hi: 'डिजिटल डिलिवरेबल्स' },
    items: [
      { id: 'edited_photos', label: { en: 'Edited Photos', te: 'ఎడిట్ చేసిన ఫోటోలు', hi: 'एडिटेड फ़ोटो' } },
      { id: 'raw_photos', label: { en: 'Raw Photos', te: 'రా ఫోటోలు', hi: 'रॉ फ़ोटो' } },
      { id: 'highlight_video', label: { en: 'Highlight Video', te: 'హైలైట్ వీడియో', hi: 'हाइलाइट वीडियो' } },
      { id: 'teaser_video', label: { en: 'Teaser Video', te: 'టీజర్ వీడియో', hi: 'टीज़र वीडियो' } },
      { id: 'instagram_reels', label: { en: 'Instagram Reels', te: 'ఇన్‌స్టాగ్రామ్ రీల్స్', hi: 'इंस्टाग्राम रील्स' } },
      { id: 'full_film', label: { en: 'Full Wedding Film', te: 'పూర్తి వివాహ చిత్రం', hi: 'पूरी शादी फ़िल्म' } },
      { id: 'online_gallery', label: { en: 'Online Gallery Access', te: 'ఆన్‌లైన్ గ్యాలరీ యాక్సెస్', hi: 'ऑनलाइन गैलरी एक्सेस' } },
      { id: 'cloud_download', label: { en: 'Cloud Download Link', te: 'క్లౌడ్ డౌన్‌లోడ్ లింక్', hi: 'क्लाउड डाउनलोड लिंक' } },
      { id: 'slideshow_video', label: { en: 'Slideshow Video', te: 'స్లైడ్‌షో వీడియో', hi: 'स्लाइडशो वीडियो' } },
      { id: 'story_pack', label: { en: 'Social Media Story Pack', te: 'సోషల్ మీడియా స్టోరీ ప్యాక్', hi: 'सोशल मीडिया स्टोरी पैक' } },
      { id: 'whatsapp_photos', label: { en: 'WhatsApp Optimized Photos', te: 'వాట్సాప్ ఆప్టిమైజ్డ్ ఫోటోలు', hi: 'व्हाट्सऐप ऑप्टिमाइज़्ड फ़ोटो' } },
      { id: 'youtube_version', label: { en: 'YouTube Version', te: 'యూట్యూబ్ వెర్షన్', hi: 'यूट्यूब वर्शन' } },
      { id: 'mobile_album', label: { en: 'Mobile Optimized Album', te: 'మొబైల్ ఆప్టిమైజ్డ్ ఆల్బమ్', hi: 'मोबाइल ऑप्टिमाइज़्ड एल्बम' } },
      { id: 'digital_invite', label: { en: 'Digital Invitation Video', te: 'డిజిటల్ ఇన్విటేషన్ వీడియో', hi: 'डिजिटल निमंत्रण वीडियो' } },
    ],
  },
  {
    id: 'live',
    icon: 'mdi-broadcast',
    color: '#DB2777', // pink
    tint: '#FCE7F3',
    title: { en: 'Live Services', te: 'లైవ్ సేవలు', hi: 'लाइव सेवाएँ' },
    items: [
      { id: 'live_stream', label: { en: 'Live Streaming', te: 'లైవ్ స్ట్రీమింగ్', hi: 'लाइव स्ट्रीमिंग' } },
      { id: 'led_wall', label: { en: 'LED Wall Coverage', te: 'LED వాల్ కవరేజ్', hi: 'LED वॉल कवरेज' } },
      { id: 'led_tv', label: { en: 'LED TV Display', te: 'LED TV డిస్‌ప్లే', hi: 'LED TV डिस्प्ले' } },
      { id: 'photo_booth', label: { en: 'Photo Booth', te: 'ఫోటో బూత్', hi: 'फ़ोटो बूथ' } },
      { id: 'instant_print', label: { en: 'Instant Printing', te: 'ఇన్‌స్టంట్ ప్రింటింగ్', hi: 'इंस्टेंट प्रिंटिंग' } },
      { id: 'mini_movie', label: { en: 'Same-Day Edit / Mini Movie', te: 'సేమ్-డే ఎడిట్ / మినీ మూవీ', hi: 'सेम-डे एडिट / मिनी मूवी' } },
      { id: 'selfie_booth', label: { en: '360° Selfie Booth', te: '360° సెల్ఫీ బూత్', hi: '360° सेल्फ़ी बूथ' } },
      { id: 'live_projection', label: { en: 'Live Photo Projection', te: 'లైవ్ ఫోటో ప్రొజెక్షన్', hi: 'लाइव फ़ोटो प्रोजेक्शन' } },
      { id: 'guest_message', label: { en: 'Guest Message Recording Booth', te: 'గెస్ట్ మెసేజ్ రికార్డింగ్ బూత్', hi: 'गेस्ट मैसेज रिकॉर्डिंग बूथ' } },
      { id: 'instant_reel', label: { en: 'Instant Reel Creation', te: 'ఇన్‌స్టంట్ రీల్ క్రియేషన్', hi: 'इंस्टेंट रील क्रिएशन' } },
      { id: 'live_social', label: { en: 'Live Social Media Coverage', te: 'లైవ్ సోషల్ మీడియా కవరేజ్', hi: 'लाइव सोशल मीडिया कवरेज' } },
    ],
  },
  {
    id: 'addons',
    icon: 'mdi-plus-box-multiple-outline',
    color: '#0891B2', // cyan
    tint: '#CFFAFE',
    title: { en: 'Add-On Services', te: 'యాడ్-ఆన్ సేవలు', hi: 'ऐड-ऑन सेवाएँ' },
    items: [
      { id: 'extra_hours', label: { en: 'Extra Event Hours', te: 'అదనపు ఈవెంట్ గంటలు', hi: 'अतिरिक्त इवेंट घंटे' } },
      { id: 'urgent_delivery', label: { en: 'Urgent Delivery', te: 'అర్జెంట్ డెలివరీ', hi: 'अर्जेंट डिलीवरी' } },
      { id: 'express_album', label: { en: 'Express Album Delivery', te: 'ఎక్స్‌ప్రెస్ ఆల్బమ్ డెలివరీ', hi: 'एक्सप्रेस एल्बम डिलीवरी' } },
      { id: 'addl_album_copies', label: { en: 'Additional Album Copies', te: 'అదనపు ఆల్బమ్ కాపీలు', hi: 'अतिरिक्त एल्बम प्रतियाँ' } },
      { id: 'addl_edited', label: { en: 'Additional Edited Photos', te: 'అదనపు ఎడిట్ చేసిన ఫోటోలు', hi: 'अतिरिक्त एडिटेड फ़ोटो' } },
      { id: 'addl_revisions', label: { en: 'Additional Revisions', te: 'అదనపు రివిజన్‌లు', hi: 'अतिरिक्त संशोधन' } },
      { id: 'extra_drone', label: { en: 'Extra Drone Session', te: 'అదనపు డ్రోన్ సెషన్', hi: 'अतिरिक्त ड्रोन सत्र' } },
      { id: 'harddisk_delivery', label: { en: 'Hard Disk Delivery', te: 'హార్డ్ డిస్క్ డెలివరీ', hi: 'हार्ड डिस्क डिलीवरी' } },
      { id: 'pendrive_delivery', label: { en: 'Pen Drive Delivery', te: 'పెన్ డ్రైవ్ డెలివరీ', hi: 'पेन ड्राइव डिलीवरी' } },
      { id: 'courier_delivery', label: { en: 'Courier Delivery', te: 'కొరియర్ డెలివరీ', hi: 'कूरियर डिलीवरी' } },
      { id: 'backup_extension', label: { en: 'Backup Storage Extension', te: 'బ్యాకప్ స్టోరేజ్ ఎక్స్‌టెన్షన్', hi: 'बैकअप स्टोरेज एक्सटेंशन' } },
    ],
  },
  {
    id: 'travel',
    icon: 'mdi-car-outline',
    color: '#475569', // slate
    tint: '#F1F5F9',
    title: { en: 'Travel & Logistics', te: 'ప్రయాణం & లాజిస్టిక్స్', hi: 'यात्रा और लॉजिस्टिक्स' },
    items: [
      { id: 'travel_included', label: { en: 'Travel Included', te: 'ప్రయాణం చేర్చబడింది', hi: 'यात्रा शामिल' } },
      { id: 'accommodation_included', label: { en: 'Accommodation Included', te: 'వసతి చేర్చబడింది', hi: 'आवास शामिल' } },
      { id: 'outstation_charges', label: { en: 'Outstation Charges', te: 'అవుట్‌స్టేషన్ ఛార్జీలు', hi: 'आउटस्टेशन शुल्क' } },
      { id: 'toll_charges', label: { en: 'Toll Charges', te: 'టోల్ ఛార్జీలు', hi: 'टोल शुल्क' } },
      { id: 'parking_charges', label: { en: 'Parking Charges', te: 'పార్కింగ్ ఛార్జీలు', hi: 'पार्किंग शुल्क' } },
      { id: 'vehicle_charges', label: { en: 'Vehicle Charges', te: 'వాహన ఛార్జీలు', hi: 'वाहन शुल्क' } },
      { id: 'flight_charges', label: { en: 'Flight Charges', te: 'ఫ్లైట్ ఛార్జీలు', hi: 'फ़्लाइट शुल्क' } },
      { id: 'train_charges', label: { en: 'Train Charges', te: 'రైలు ఛార్జీలు', hi: 'ट्रेन शुल्क' } },
    ],
  },
]

/* ──────────────────────────────────────────────────────────────────────────
 * Predefined legal clauses — toggled on/off, each fully translated.
 * Toggling inserts the body in the agreement's selected language.
 * ────────────────────────────────────────────────────────────────────────── */


export const PREDEFINED_CLAUSES = [
  {
    id: 'raw_files',
    title: { en: 'Raw Files Included After Final Delivery', te: 'తుది డెలివరీ తర్వాత రా ఫైల్స్ చేర్చబడతాయి', hi: 'अंतिम डिलीवरी के बाद रॉ फ़ाइलें शामिल' },
    body: {
      en: 'Raw files will be shared only after the album design and final deliverables are completed. Any storage media required for delivery, including pen drives, hard disks, SSDs, or courier charges, shall be borne by the customer.',
      te: 'ఆల్బమ్ డిజైన్ మరియు తుది డెలివరబుల్స్ పూర్తయిన తర్వాత మాత్రమే రా ఫైల్స్ పంచుకోబడతాయి. డెలివరీ కోసం అవసరమైన పెన్ డ్రైవ్‌లు, హార్డ్ డిస్క్‌లు, SSDలు లేదా కొరియర్ ఛార్జీలతో సహా ఏదైనా నిల్వ మాధ్యమాన్ని కస్టమర్ భరించాలి.',
      hi: 'रॉ फ़ाइलें केवल एल्बम डिज़ाइन और अंतिम डिलिवरेबल्स पूरे होने के बाद ही साझा की जाएँगी। डिलीवरी के लिए आवश्यक कोई भी स्टोरेज मीडिया, जिसमें पेन ड्राइव, हार्ड डिस्क, SSD, या कूरियर शुल्क शामिल हैं, ग्राहक द्वारा वहन किया जाएगा।',
    },
  },
  {
    id: 'non_refundable',
    title: { en: 'Non-Refundable Advance', te: 'తిరిగి చెల్లించని అడ్వాన్స్', hi: 'गैर-वापसी योग्य अग्रिम' },
    body: {
      en: 'The booking advance paid to confirm the date is non-refundable under any circumstances, as it reserves the photographer exclusively for your event date.',
      te: 'తేదీని నిర్ధారించడానికి చెల్లించిన బుకింగ్ అడ్వాన్స్ ఏ పరిస్థితిలోనైనా తిరిగి చెల్లించబడదు, ఎందుకంటే ఇది మీ ఈవెంట్ తేదీ కోసం ఫోటోగ్రాఫర్‌ను ప్రత్యేకంగా రిజర్వ్ చేస్తుంది.',
      hi: 'तारीख़ की पुष्टि के लिए दिया गया बुकिंग अग्रिम किसी भी परिस्थिति में वापस नहीं किया जाएगा, क्योंकि यह आपके इवेंट की तारीख़ के लिए फ़ोटोग्राफ़र को विशेष रूप से आरक्षित करता है।',
    },
  },
  {
    id: 'addl_hours',
    title: { en: 'Additional Hours Chargeable', te: 'అదనపు గంటలకు ఛార్జ్', hi: 'अतिरिक्त घंटे शुल्क योग्य' },
    body: {
      en: 'Coverage beyond the agreed hours will be billed at the photographer\'s standard hourly rate. Overtime must be approved by the client on-site before it begins.',
      te: 'అంగీకరించిన గంటలకు మించిన కవరేజ్ ఫోటోగ్రాఫర్ ప్రామాణిక గంట రేటు ప్రకారం బిల్ చేయబడుతుంది. ఓవర్‌టైమ్ ప్రారంభించడానికి ముందు క్లయింట్ సైట్‌లో ఆమోదించాలి.',
      hi: 'सहमत घंटों से अधिक कवरेज फ़ोटोग्राफ़र की मानक प्रति घंटा दर पर बिल किया जाएगा। ओवरटाइम शुरू होने से पहले क्लाइंट द्वारा साइट पर अनुमोदित किया जाना चाहिए।',
    },
  },
  {
    id: 'drone_weather',
    title: { en: 'Drone Subject To Weather', te: 'డ్రోన్ వాతావరణంపై ఆధారపడి', hi: 'ड्रोन मौसम पर निर्भर' },
    body: {
      en: 'Drone coverage is subject to weather conditions, venue restrictions, and local regulations. If flying is unsafe or prohibited, this service may be withdrawn without affecting the rest of the agreement.',
      te: 'డ్రోన్ కవరేజ్ వాతావరణ పరిస్థితులు, వేదిక పరిమితులు మరియు స్థానిక నిబంధనలపై ఆధారపడి ఉంటుంది. ఎగరడం సురక్షితం కాకపోతే లేదా నిషేధించబడితే, ఒప్పందంలోని మిగిలిన భాగాన్ని ప్రభావితం చేయకుండా ఈ సేవ ఉపసంహరించబడవచ్చు.',
      hi: 'ड्रोन कवरेज मौसम की स्थिति, स्थल प्रतिबंधों और स्थानीय नियमों के अधीन है। यदि उड़ान असुरक्षित या प्रतिबंधित है, तो शेष समझौते को प्रभावित किए बिना यह सेवा वापस ली जा सकती है।',
    },
  },
  {
    id: 'portfolio_usage',
    title: { en: 'Portfolio Usage Allowed', te: 'పోర్ట్‌ఫోలియో వాడకం అనుమతించబడింది', hi: 'पोर्टफ़ोलियो उपयोग की अनुमति' },
    body: {
      en: 'The client grants the photographer permission to use selected images and videos from this event for portfolio, website, and social media promotion. The client may opt out in writing before the event.',
      te: 'ఈ ఈవెంట్ నుండి ఎంచుకున్న చిత్రాలు మరియు వీడియోలను పోర్ట్‌ఫోలియో, వెబ్‌సైట్ మరియు సోషల్ మీడియా ప్రచారం కోసం ఉపయోగించడానికి క్లయింట్ ఫోటోగ్రాఫర్‌కు అనుమతి ఇస్తారు. క్లయింట్ ఈవెంట్‌కు ముందు వ్రాతపూర్వకంగా నిరాకరించవచ్చు.',
      hi: 'क्लाइंट फ़ोटोग्राफ़र को इस इवेंट की चयनित छवियों और वीडियो को पोर्टफ़ोलियो, वेबसाइट और सोशल मीडिया प्रचार के लिए उपयोग करने की अनुमति देता है। क्लाइंट इवेंट से पहले लिखित रूप में मना कर सकता है।',
    },
  },
  {
    id: 'final_after_payment',
    title: { en: 'Final Delivery After Full Payment', te: 'పూర్తి చెల్లింపు తర్వాత తుది డెలివరీ', hi: 'पूर्ण भुगतान के बाद अंतिम डिलीवरी' },
    body: {
      en: 'Final high-resolution files, albums, and films will be released only after the full package amount has been settled. Preview / watermarked copies may be shared earlier.',
      te: 'తుది హై-రిజల్యూషన్ ఫైల్స్, ఆల్బమ్‌లు మరియు చిత్రాలు పూర్తి ప్యాకేజీ మొత్తం చెల్లించిన తర్వాత మాత్రమే విడుదల చేయబడతాయి. ప్రివ్యూ / వాటర్‌మార్క్ కాపీలు ముందుగా పంచుకోవచ్చు.',
      hi: 'अंतिम हाई-रिज़ॉल्यूशन फ़ाइलें, एल्बम और फ़िल्में पूर्ण पैकेज राशि के निपटान के बाद ही जारी की जाएँगी। प्रीव्यू / वॉटरमार्क प्रतियाँ पहले साझा की जा सकती हैं।',
    },
  },
  {
    id: 'data_retention',
    title: { en: 'Data Retention Policy', te: 'డేటా నిల్వ విధానం', hi: 'डेटा प्रतिधारण नीति' },
    body: {
      en: 'Delivered files will be retained on the photographer\'s storage for the agreed retention period only. The client is responsible for downloading and backing up all files before this period ends.',
      te: 'డెలివరీ చేసిన ఫైల్స్ అంగీకరించిన నిల్వ వ్యవధికి మాత్రమే ఫోటోగ్రాఫర్ స్టోరేజ్‌లో ఉంచబడతాయి. ఈ వ్యవధి ముగియడానికి ముందు అన్ని ఫైల్స్‌ను డౌన్‌లోడ్ చేసి బ్యాకప్ చేయడం క్లయింట్ బాధ్యత.',
      hi: 'डिलीवर की गई फ़ाइलें केवल सहमत प्रतिधारण अवधि के लिए फ़ोटोग्राफ़र के स्टोरेज पर रखी जाएँगी। इस अवधि के समाप्त होने से पहले सभी फ़ाइलों को डाउनलोड और बैकअप करना क्लाइंट की ज़िम्मेदारी है।',
    },
  },
  {
    id: 'liability',
    title: { en: 'Limitation Of Liability', te: 'బాధ్యత పరిమితి', hi: 'दायित्व की सीमा' },
    body: {
      en: 'In the unlikely event of equipment failure, data loss, or circumstances beyond the photographer\'s control, liability is limited to a refund of the amount paid. The photographer is not liable for indirect or consequential losses.',
      te: 'పరికరాల వైఫల్యం, డేటా నష్టం లేదా ఫోటోగ్రాఫర్ నియంత్రణకు మించిన పరిస్థితుల అరుదైన సందర్భంలో, బాధ్యత చెల్లించిన మొత్తాన్ని తిరిగి చెల్లించడానికి పరిమితం. పరోక్ష లేదా పర్యవసాన నష్టాలకు ఫోటోగ్రాఫర్ బాధ్యత వహించరు.',
      hi: 'उपकरण विफलता, डेटा हानि, या फ़ोटोग्राफ़र के नियंत्रण से परे परिस्थितियों की असंभावित घटना में, दायित्व भुगतान की गई राशि की वापसी तक सीमित है। फ़ोटोग्राफ़र अप्रत्यक्ष या परिणामी नुकसान के लिए उत्तरदायी नहीं है।',
    },
  },
  {
    id: 'force_majeure',
    title: { en: 'Force Majeure', te: 'ఫోర్స్ మేజర్', hi: 'अप्रत्याशित घटना' },
    body: {
      en: 'Neither party is liable for failure to perform due to events beyond reasonable control — natural disasters, accidents, illness, government restrictions. In such cases the parties will reschedule in good faith.',
      te: 'సహజ విపత్తులు, ప్రమాదాలు, అనారోగ్యం, ప్రభుత్వ ఆంక్షలు వంటి సహేతుకమైన నియంత్రణకు మించిన సంఘటనల కారణంగా నిర్వహించడంలో వైఫల్యానికి ఏ పక్షం బాధ్యత వహించదు. అటువంటి సందర్భాలలో పక్షాలు సద్భావనతో రీషెడ్యూల్ చేస్తాయి.',
      hi: 'कोई भी पक्ष उचित नियंत्रण से परे घटनाओं — प्राकृतिक आपदाओं, दुर्घटनाओं, बीमारी, सरकारी प्रतिबंधों — के कारण प्रदर्शन में विफलता के लिए उत्तरदायी नहीं है। ऐसे मामलों में पक्ष सद्भावना से पुनर्निर्धारण करेंगे।',
    },
  },
  {
    id: 'cancellation',
    title: { en: 'Cancellation Policy', te: 'రద్దు విధానం', hi: 'रद्दीकरण नीति' },
    body: {
      en: 'Cancellations made more than 30 days before the event forfeit the booking advance only. Cancellations within 30 days may be charged up to 50% of the package amount to cover reserved dates and lost bookings.',
      te: 'ఈవెంట్‌కు 30 రోజులకు ముందు చేసిన రద్దులు బుకింగ్ అడ్వాన్స్‌ను మాత్రమే కోల్పోతాయి. 30 రోజులలోపు రద్దుల కోసం రిజర్వ్ చేసిన తేదీలు మరియు కోల్పోయిన బుకింగ్‌లను కవర్ చేయడానికి ప్యాకేజీ మొత్తంలో 50% వరకు ఛార్జ్ చేయబడవచ్చు.',
      hi: 'इवेंट से 30 दिन पहले की गई रद्दीकरण केवल बुकिंग अग्रिम ज़ब्त करती है। 30 दिनों के भीतर रद्दीकरण के लिए आरक्षित तारीख़ों और खोई हुई बुकिंग को कवर करने हेतु पैकेज राशि का 50% तक शुल्क लिया जा सकता है।',
    },
  },
  {
    id: 'reschedule',
    title: { en: 'Rescheduling Policy', te: 'రీషెడ్యూల్ విధానం', hi: 'पुनर्निर्धारण नीति' },
    body: {
      en: 'One rescheduling of the event is allowed at no extra cost if requested at least 30 days in advance and a new date is mutually agreed, subject to the photographer\'s availability. Further rescheduling may incur additional charges.',
      te: 'కనీసం 30 రోజుల ముందుగా అభ్యర్థించి, కొత్త తేదీని పరస్పరం అంగీకరిస్తే, ఫోటోగ్రాఫర్ లభ్యతకు లోబడి ఈవెంట్‌ను ఒకసారి అదనపు ఖర్చు లేకుండా రీషెడ్యూల్ చేయడానికి అనుమతి ఉంటుంది. తదుపరి రీషెడ్యూల్‌కు అదనపు ఛార్జీలు వర్తించవచ్చు.',
      hi: 'यदि कम से कम 30 दिन पहले अनुरोध किया जाए और नई तारीख़ पर आपसी सहमति हो, तो फ़ोटोग्राफ़र की उपलब्धता के अधीन इवेंट को एक बार बिना अतिरिक्त शुल्क के पुनर्निर्धारित किया जा सकता है। आगे पुनर्निर्धारण पर अतिरिक्त शुल्क लग सकता है।',
    },
  },
  {
    id: 'client_cooperation',
    title: { en: 'Client Cooperation', te: 'క్లయింట్ సహకారం', hi: 'ग्राहक सहयोग' },
    body: {
      en: 'Delivery timelines assume timely client cooperation. Delays caused by the client — including delayed photo selection, approvals, payments, or unavailability for review sessions — will extend the agreed delivery timelines accordingly, without liability to the photographer.',
      te: 'డెలివరీ సమయపాలన క్లయింట్ సకాలంలో సహకారాన్ని ఊహిస్తుంది. ఆలస్యమైన ఫోటో ఎంపిక, ఆమోదాలు, చెల్లింపులు లేదా రివ్యూ సెషన్‌లకు అందుబాటులో లేకపోవడం వంటి క్లయింట్ వల్ల కలిగే ఆలస్యాలు, ఫోటోగ్రాఫర్‌కు బాధ్యత లేకుండా అంగీకరించిన డెలివరీ సమయపాలనను తదనుగుణంగా పొడిగిస్తాయి.',
      hi: 'डिलीवरी समयसीमा ग्राहक के समय पर सहयोग को मानती है। ग्राहक के कारण होने वाली देरी — जिसमें फ़ोटो चयन, अनुमोदन, भुगतान में देरी, या समीक्षा सत्रों के लिए अनुपलब्धता शामिल है — सहमत डिलीवरी समयसीमा को तदनुसार बढ़ा देगी, फ़ोटोग्राफ़र पर बिना किसी दायित्व के।',
    },
  },
  {
    id: 'copyright',
    title: { en: 'Copyright & Usage Rights', te: 'కాపీరైట్ & వినియోగ హక్కులు', hi: 'कॉपीराइट और उपयोग अधिकार' },
    body: {
      en: 'The photographer retains full copyright of all images and footage. The client receives personal, non-commercial usage rights to the delivered files. Any commercial use, resale, or publication for profit requires the photographer\'s prior written permission.',
      te: 'అన్ని చిత్రాలు మరియు ఫుటేజ్‌పై ఫోటోగ్రాఫర్ పూర్తి కాపీరైట్‌ను కలిగి ఉంటారు. క్లయింట్ డెలివరీ చేసిన ఫైల్స్‌కు వ్యక్తిగత, వాణిజ్యేతర వినియోగ హక్కులను పొందుతారు. ఏదైనా వాణిజ్య వినియోగం, పునఃవిక్రయం లేదా లాభం కోసం ప్రచురణకు ఫోటోగ్రాఫర్ ముందస్తు వ్రాతపూర్వక అనుమతి అవసరం.',
      hi: 'फ़ोटोग्राफ़र सभी छवियों और फ़ुटेज का पूर्ण कॉपीराइट रखता है। ग्राहक को डिलीवर की गई फ़ाइलों के व्यक्तिगत, गैर-वाणिज्यिक उपयोग अधिकार मिलते हैं। किसी भी वाणिज्यिक उपयोग, पुनर्विक्रय, या लाभ हेतु प्रकाशन के लिए फ़ोटोग्राफ़र की पूर्व लिखित अनुमति आवश्यक है।',
    },
  },
  {
    id: 'replacement',
    title: { en: 'Replacement Photographer', te: 'ప్రత్యామ్నాయ ఫోటోగ్రాఫర్', hi: 'प्रतिस्थापन फ़ोटोग्राफ़र' },
    body: {
      en: 'In the event the assigned photographer is unavailable due to illness, emergency, or unforeseen circumstances, the studio reserves the right to assign an equally qualified replacement photographer to ensure the event is covered without compromising quality.',
      te: 'కేటాయించిన ఫోటోగ్రాఫర్ అనారోగ్యం, అత్యవసర పరిస్థితి లేదా ఊహించని పరిస్థితుల కారణంగా అందుబాటులో లేకపోతే, నాణ్యతను రాజీ పడకుండా ఈవెంట్ కవర్ చేయడానికి సమానంగా అర్హత కలిగిన ప్రత్యామ్నాయ ఫోటోగ్రాఫర్‌ను కేటాయించే హక్కును స్టూడియో కలిగి ఉంటుంది.',
      hi: 'यदि नियुक्त फ़ोटोग्राफ़र बीमारी, आपातकाल, या अप्रत्याशित परिस्थितियों के कारण अनुपलब्ध हो, तो स्टूडियो गुणवत्ता से समझौता किए बिना इवेंट कवरेज सुनिश्चित करने हेतु समान रूप से योग्य प्रतिस्थापन फ़ोटोग्राफ़र नियुक्त करने का अधिकार सुरक्षित रखता है।',
    },
  },
  {
    id: 'travel',
    title: { en: 'Travel & Accommodation', te: 'ప్రయాణం & వసతి', hi: 'यात्रा और आवास' },
    body: {
      en: 'For events outside the studio\'s base city, travel, accommodation, and local transport costs for the crew are to be borne by the client, either arranged directly or reimbursed at actuals, unless otherwise stated in the package.',
      te: 'స్టూడియో బేస్ నగరం వెలుపలి ఈవెంట్‌ల కోసం, ప్యాకేజీలో పేర్కొనకపోతే, సిబ్బంది కోసం ప్రయాణం, వసతి మరియు స్థానిక రవాణా ఖర్చులను క్లయింట్ భరించాలి, నేరుగా ఏర్పాటు చేయడం లేదా వాస్తవ ఖర్చుల ప్రకారం తిరిగి చెల్లించడం.',
      hi: 'स्टूडियो के बेस शहर के बाहर के इवेंट के लिए, जब तक पैकेज में अन्यथा न कहा गया हो, क्रू के लिए यात्रा, आवास, और स्थानीय परिवहन लागत ग्राहक द्वारा वहन की जाएगी, या तो सीधे व्यवस्थित या वास्तविक आधार पर प्रतिपूर्ति की जाएगी।',
    },
  },
  {
    id: 'late_payment',
    title: { en: 'Late Payment', te: 'ఆలస్య చెల్లింపు', hi: 'विलंबित भुगतान' },
    body: {
      en: 'Final deliverables — including albums, films, and high-resolution files — may be withheld until all outstanding payments are cleared in full. Delivery timelines pause while any payment remains overdue.',
      te: 'బకాయి చెల్లింపులన్నీ పూర్తిగా చెల్లించే వరకు ఆల్బమ్‌లు, చిత్రాలు మరియు హై-రిజల్యూషన్ ఫైల్స్‌తో సహా తుది డెలివరబుల్స్ నిలిపివేయబడవచ్చు. ఏదైనా చెల్లింపు బకాయి ఉన్నప్పుడు డెలివరీ సమయపాలన నిలిచిపోతుంది.',
      hi: 'अंतिम डिलिवरेबल्स — एल्बम, फ़िल्म, और हाई-रिज़ॉल्यूशन फ़ाइलों सहित — सभी बकाया भुगतान पूरी तरह से चुकाए जाने तक रोके जा सकते हैं। किसी भी भुगतान के बकाया रहने पर डिलीवरी समयसीमा रुक जाती है।',
    },
  },
]

/**
 * MANDATORY Framedrops platform disclaimer — appended to the end of EVERY
 * generated agreement automatically (not toggleable). It makes clear Framedrops
 * is only the tooling/storage platform and not a party to the agreement.
 */
export const FRAMEDROPS_DISCLAIMER = {
  id: 'framedrops_disclaimer',
  title: { en: 'Framedrops Platform Disclaimer', te: 'Framedrops ప్లాట్‌ఫారమ్ నిరాకరణ', hi: 'Framedrops प्लेटफ़ॉर्म अस्वीकरण' },
  body: {
    en: 'Framedrops acts only as a technology platform that facilitates the generation, management, and storage of agreements between photographers and their customers. Framedrops is not a legal advisor and does not provide legal advice. Framedrops is not a party to this agreement and is not responsible for its terms, for any payment disputes, or for any service-delivery disputes. Framedrops is not responsible for the actions, decisions, or conduct of either the photographer or the customer. All commitments, obligations, responsibilities, and liabilities arising from this agreement remain exclusively between the photographer and the customer.',
    te: 'Framedrops కేవలం ఫోటోగ్రాఫర్‌లు మరియు వారి కస్టమర్‌ల మధ్య ఒప్పందాల రూపకల్పన, నిర్వహణ మరియు నిల్వను సులభతరం చేసే సాంకేతిక ప్లాట్‌ఫారమ్‌గా మాత్రమే పనిచేస్తుంది. Framedrops చట్టపరమైన సలహాదారు కాదు మరియు చట్టపరమైన సలహా ఇవ్వదు. Framedrops ఈ ఒప్పందంలో పక్షం కాదు మరియు దాని నిబంధనలకు, ఏదైనా చెల్లింపు వివాదాలకు లేదా సేవా-డెలివరీ వివాదాలకు బాధ్యత వహించదు. ఫోటోగ్రాఫర్ లేదా కస్టమర్ చర్యలు, నిర్ణయాలు లేదా ప్రవర్తనకు Framedrops బాధ్యత వహించదు. ఈ ఒప్పందం నుండి ఉత్పన్నమయ్యే అన్ని నిబద్ధతలు, బాధ్యతలు ఫోటోగ్రాఫర్ మరియు కస్టమర్ మధ్య మాత్రమే ఉంటాయి.',
    hi: 'Framedrops केवल एक तकनीकी प्लेटफ़ॉर्म के रूप में कार्य करता है जो फ़ोटोग्राफ़रों और उनके ग्राहकों के बीच अनुबंधों के निर्माण, प्रबंधन और संग्रहण को सुगम बनाता है। Framedrops कानूनी सलाहकार नहीं है और कानूनी सलाह नहीं देता। Framedrops इस अनुबंध का पक्ष नहीं है और इसकी शर्तों, किसी भी भुगतान विवाद, या किसी भी सेवा-वितरण विवाद के लिए ज़िम्मेदार नहीं है। Framedrops फ़ोटोग्राफ़र या ग्राहक के कार्यों, निर्णयों या आचरण के लिए ज़िम्मेदार नहीं है। इस अनुबंध से उत्पन्न सभी प्रतिबद्धताएँ, दायित्व और ज़िम्मेदारियाँ केवल फ़ोटोग्राफ़र और ग्राहक के बीच रहती हैं।',
  },
}

/* ──────────────────────────────────────────────────────────────────────────
 * Deliverable name options (dropdown) — non-techie friendly preset list.
 * ────────────────────────────────────────────────────────────────────────── */


export const DELIVERABLE_OPTIONS = [
  { value: 'Wedding Album', label: { en: 'Wedding Album', te: 'వివాహ ఆల్బమ్', hi: 'शादी एल्बम' } },
  { value: 'Custom Album', label: { en: 'Custom Album', te: 'కస్టమ్ ఆల్బమ్', hi: 'कस्टम एल्बम' } },
  { value: 'Cinematic Video', label: { en: 'Cinematic Video', te: 'సినిమాటిక్ వీడియో', hi: 'सिनेमैटिक वीडियो' } },
  { value: 'Highlight Video', label: { en: 'Highlight Video', te: 'హైలైట్ వీడియో', hi: 'हाइलाइट वीडियो' } },
  { value: 'Teaser Video', label: { en: 'Teaser Video', te: 'టీజర్ వీడియో', hi: 'टीज़र वीडियो' } },
  { value: 'Full Wedding Film', label: { en: 'Full Wedding Film', te: 'పూర్తి వివాహ చిత్రం', hi: 'पूरी शादी फ़िल्म' } },
  { value: 'Edited Photos', label: { en: 'Edited Photos', te: 'ఎడిట్ చేసిన ఫోటోలు', hi: 'एडिटेड फ़ोटो' } },
  { value: 'Raw Photos', label: { en: 'Raw Photos', te: 'రా ఫోటోలు', hi: 'रॉ फ़ोटो' } },
  { value: 'Social Media Reel', label: { en: 'Social Media Reel', te: 'సోషల్ మీడియా రీల్', hi: 'सोशल मीडिया रील' } },
  { value: 'Drone Footage', label: { en: 'Drone Footage', te: 'డ్రోన్ ఫుటేజ్', hi: 'ड्रोन फ़ुटेज' } },
  { value: 'Framed Prints', label: { en: 'Framed Prints', te: 'ఫ్రేమ్ ప్రింట్‌లు', hi: 'फ़्रेम प्रिंट' } },
  { value: 'Online Gallery', label: { en: 'Online Gallery Access', te: 'ఆన్‌లైన్ గ్యాలరీ', hi: 'ऑनलाइन गैलरी' } },
  { value: 'Other', label: { en: 'Other', te: 'ఇతరం', hi: 'अन्य' } },
]

/* Delivery-timeline options (days). No "Custom" — fixed buckets only. */
export const DELIVERY_TIMELINE_OPTIONS = [
  '7 Days', '15 Days', '30 Days', '60 Days', '90 Days', '180 Days', '360 Days',
]

/* Data-retention options (days within one year). No custom input. */
export const RETENTION_OPTIONS = [
  { value: '30', label: { en: '30 Days', te: '30 రోజులు', hi: '30 दिन' } },
  { value: '60', label: { en: '60 Days', te: '60 రోజులు', hi: '60 दिन' } },
  { value: '90', label: { en: '90 Days', te: '90 రోజులు', hi: '90 दिन' } },
  { value: '180', label: { en: '180 Days', te: '180 రోజులు', hi: '180 दिन' } },
  { value: '270', label: { en: '270 Days', te: '270 రోజులు', hi: '270 दिन' } },
  { value: '365', label: { en: '365 Days', te: '365 రోజులు', hi: '365 दिन' } },
]

/* ──────────────────────────────────────────────────────────────────────────
 * Payment-milestone presets — quick-apply split templates.
 * ────────────────────────────────────────────────────────────────────────── */


export const PAYMENT_PRESETS = [
  {
    id: 'wedding',
    label: { en: 'Wedding · 50 / 30 / 20', te: 'వివాహం · 50 / 30 / 20', hi: 'शादी · 50 / 30 / 20' },
    milestones: [
      { name: { en: 'Booking Advance', te: 'బుకింగ్ అడ్వాన్స్', hi: 'बुकिंग अग्रिम' }, pct: 50 },
      { name: { en: 'Event Day', te: 'ఈవెంట్ రోజు', hi: 'इवेंट दिवस' }, pct: 30 },
      { name: { en: 'Before Final Delivery', te: 'తుది డెలివరీకి ముందు', hi: 'अंतिम डिलीवरी से पहले' }, pct: 20 },
    ],
  },
  {
    id: 'standard',
    label: { en: 'Standard · 70 / 30', te: 'స్టాండర్డ్ · 70 / 30', hi: 'मानक · 70 / 30' },
    milestones: [
      { name: { en: 'Advance', te: 'అడ్వాన్స్', hi: 'अग्रिम' }, pct: 70 },
      { name: { en: 'Before Delivery', te: 'డెలివరీకి ముందు', hi: 'डिलीवरी से पहले' }, pct: 30 },
    ],
  },
  {
    id: 'thirds',
    label: { en: 'Three-Part · 30 / 40 / 30', te: 'మూడు-భాగాలు · 30 / 40 / 30', hi: 'तीन-भाग · 30 / 40 / 30' },
    milestones: [
      { name: { en: 'Booking Advance', te: 'బుకింగ్ అడ్వాన్స్', hi: 'बुकिंग अग्रिम' }, pct: 30 },
      { name: { en: 'Before Event', te: 'ఈవెంట్‌కు ముందు', hi: 'इवेंट से पहले' }, pct: 40 },
      { name: { en: 'Before Delivery', te: 'డెలివరీకి ముందు', hi: 'डिलीवरी से पहले' }, pct: 30 },
    ],
  },
]

/* ──────────────────────────────────────────────────────────────────────────
 * Agreement templates — pick one to auto-fill services, deliverables, clauses,
 * timelines and payment split for a common shoot type. Non-techie fast start.
 * ────────────────────────────────────────────────────────────────────────── */


/** Clauses every template turns on by default (sensible protective baseline). */
const BASE_CLAUSES = ['raw_files', 'non_refundable', 'final_after_payment', 'cancellation', 'copyright', 'client_cooperation', 'late_payment']

export const AGREEMENT_TEMPLATES = [
  {
    id: 'wedding',
    icon: 'mdi-ring',
    color: '#7c3aed',
    name: { en: 'Wedding Photography', te: 'వివాహ ఫోటోగ్రఫీ', hi: 'शादी फ़ोटोग्राफ़ी' },
    eventType: 'wedding',
    services: ['trad_photo', 'candid_photo', 'addl_photographer', 'cinematic_video', 'drone', 'wedding_album', 'premium_album', 'edited_photos', 'highlight_video', 'teaser_video', 'live_stream'],
    deliverables: [
      { name: 'Edited Photos', qty: 500, desc: 'High-resolution, color graded' },
      { name: 'Highlight Video', qty: 1, desc: '4–5 min cinematic edit' },
      { name: 'Wedding Album', qty: 1, desc: '40-page premium lay-flat' },
    ],
    clauses: [...BASE_CLAUSES, 'reschedule', 'force_majeure', 'travel', 'replacement', 'data_retention'],
    paymentPreset: 'wedding',
    timeline: { photos: '30 Days', video: '60 Days', album: '90 Days' },
    retention: '180',
  },
  {
    id: 'pre_wedding',
    icon: 'mdi-heart-multiple-outline',
    color: '#DB2777',
    name: { en: 'Pre-Wedding Shoot', te: 'ప్రీ-వెడ్డింగ్ షూట్', hi: 'प्री-वेडिंग शूट' },
    eventType: 'wedding',
    services: ['candid_photo', 'cinematic_video', 'drone', 'edited_photos', 'teaser_video'],
    deliverables: [
      { name: 'Edited Photos', qty: 80, desc: 'Color graded' },
      { name: 'Teaser Video', qty: 1, desc: '1 min reel' },
    ],
    clauses: [...BASE_CLAUSES, 'portfolio_usage', 'travel'],
    paymentPreset: 'standard',
    timeline: { photos: '15 Days', video: '30 Days', album: '30 Days' },
    retention: '90',
  },
  {
    id: 'engagement',
    icon: 'mdi-diamond-stone',
    color: '#0EA5E9',
    name: { en: 'Engagement', te: 'నిశ్చితార్థం', hi: 'सगाई' },
    eventType: 'engagement',
    services: ['trad_photo', 'candid_photo', 'highlight_video', 'edited_photos'],
    deliverables: [
      { name: 'Edited Photos', qty: 200, desc: 'Color graded' },
      { name: 'Highlight Video', qty: 1, desc: '2–3 min edit' },
    ],
    clauses: [...BASE_CLAUSES],
    paymentPreset: 'standard',
    timeline: { photos: '15 Days', video: '30 Days', album: '30 Days' },
    retention: '90',
  },
  {
    id: 'maternity',
    icon: 'mdi-baby-carriage',
    color: '#D97706',
    name: { en: 'Maternity Shoot', te: 'మెటర్నిటీ షూట్', hi: 'मैटरनिटी शूट' },
    eventType: 'maternity',
    services: ['candid_photo', 'family_portrait', 'edited_photos'],
    deliverables: [{ name: 'Edited Photos', qty: 100, desc: 'Studio + outdoor' }],
    clauses: [...BASE_CLAUSES, 'portfolio_usage'],
    paymentPreset: 'standard',
    timeline: { photos: '15 Days', video: '30 Days', album: '30 Days' },
    retention: '90',
  },
  {
    id: 'birthday',
    icon: 'mdi-cake-variant-outline',
    color: '#16A34A',
    name: { en: 'Birthday Event', te: 'పుట్టినరోజు ఈవెంట్', hi: 'जन्मदिन इवेंट' },
    eventType: 'birthday',
    services: ['candid_photo', 'photo_booth', 'edited_photos', 'highlight_video'],
    deliverables: [
      { name: 'Edited Photos', qty: 150, desc: 'Color graded' },
      { name: 'Highlight Video', qty: 1, desc: '2 min edit' },
    ],
    clauses: [...BASE_CLAUSES],
    paymentPreset: 'standard',
    timeline: { photos: '15 Days', video: '30 Days', album: '30 Days' },
    retention: '60',
  },
  {
    id: 'corporate',
    icon: 'mdi-office-building-outline',
    color: '#0EA5E9',
    name: { en: 'Corporate Event', te: 'కార్పొరేట్ ఈవెంట్', hi: 'कॉर्पोरेट इवेंट' },
    eventType: 'corporate',
    services: ['trad_photo', 'addl_photographer', 'multi_cam', 'live_stream', 'led_wall', 'edited_photos', 'highlight_video'],
    deliverables: [
      { name: 'Edited Photos', qty: 400, desc: 'Same-day select + full set' },
      { name: 'Highlight Video', qty: 1, desc: 'Event recap' },
    ],
    clauses: [...BASE_CLAUSES, 'addl_hours', 'liability'],
    paymentPreset: 'standard',
    timeline: { photos: '7 Days', video: '15 Days', album: '30 Days' },
    retention: '365',
  },
  {
    id: 'product',
    icon: 'mdi-camera-iris',
    color: '#7c3aed',
    name: { en: 'Product Photography', te: 'ప్రోడక్ట్ ఫోటోగ్రఫీ', hi: 'प्रोडक्ट फ़ोटोग्राफ़ी' },
    eventType: 'other',
    services: ['product_photo', 'edited_photos'],
    deliverables: [{ name: 'Edited Photos', qty: 50, desc: 'Per-product, retouched' }],
    clauses: [...BASE_CLAUSES, 'copyright'],
    paymentPreset: 'standard',
    timeline: { photos: '7 Days', video: '15 Days', album: '15 Days' },
    retention: '90',
  },
  {
    id: 'fashion',
    icon: 'mdi-hanger',
    color: '#DB2777',
    name: { en: 'Fashion Photography', te: 'ఫ్యాషన్ ఫోటోగ్రఫీ', hi: 'फ़ैशन फ़ोटोग्राफ़ी' },
    eventType: 'other',
    services: ['product_photo', 'candid_photo', 'edited_photos', 'instagram_reels'],
    deliverables: [
      { name: 'Edited Photos', qty: 60, desc: 'Editorial retouch' },
      { name: 'Social Media Reel', qty: 2, desc: 'Vertical reels' },
    ],
    clauses: [...BASE_CLAUSES, 'copyright', 'portfolio_usage'],
    paymentPreset: 'standard',
    timeline: { photos: '15 Days', video: '15 Days', album: '30 Days' },
    retention: '90',
  },
  {
    id: 'real_estate',
    icon: 'mdi-home-city-outline',
    color: '#16A34A',
    name: { en: 'Real Estate Photography', te: 'రియల్ ఎస్టేట్ ఫోటోగ్రఫీ', hi: 'रियल एस्टेट फ़ोटोग्राफ़ी' },
    eventType: 'other',
    services: ['trad_photo', 'drone', 'edited_photos'],
    deliverables: [
      { name: 'Edited Photos', qty: 40, desc: 'HDR interiors + exteriors' },
      { name: 'Drone Footage', qty: 1, desc: 'Aerial walkthrough' },
    ],
    clauses: [...BASE_CLAUSES, 'copyright', 'drone_weather'],
    paymentPreset: 'standard',
    timeline: { photos: '7 Days', video: '15 Days', album: '15 Days' },
    retention: '90',
  },
]

/* ──────────────────────────────────────────────────────────────────────────
 * UI strings for the rendered PDF preview / acceptance page, per language.
 * (These are the document's own headings — independent of the app's vue-i18n.)
 * ────────────────────────────────────────────────────────────────────────── */

export const DOC_STRINGS = {
  en: {
    title: 'Photography Service Agreement',
    customerInfo: 'Customer Information',
    eventInfo: 'Event Information',
    services: 'Services Included',
    deliverables: 'Deliverables',
    paymentSchedule: 'Payment Schedule',
    terms: 'Terms & Conditions',
    retention: 'Data Retention',
    name: 'Name',
    email: 'Email',
    phone: 'Phone',
    event: 'Event',
    eventType: 'Type',
    date: 'Date',
    venue: 'Venue',
    milestone: 'Milestone',
    amount: 'Amount',
    dueDate: 'Due',
    status: 'Status',
    statusPaid: 'Paid',
    statusPending: 'Pending',
    statusOverdue: 'Overdue',
    total: 'Total Package',
    retentionNote: 'Customer is responsible for downloading and backing up delivered files.',
    acceptedBy: 'Accepted by',
    issuedBy: 'Issued by',
    digitallyIssued: 'Digitally issued on send — no signature required.',
    photographerRole: 'Photographer / Studio',
    agreementNo: 'Agreement No.',
    on: 'on',
    version: 'Version',
    qty: 'Qty',
    thankYouTitle: 'Thank you',
    thankYouHeadline: 'Thank you',
    thankYouBody: 'Your booking is confirmed and this agreement is safely recorded. We can’t wait to capture your special moments — your photographer will be in touch about the next steps.',
    thankYouSigned: 'Keep this signed copy for your records.',
    securelySigned: 'Securely signed & stored via',
  },
  te: {
    title: 'ఫోటోగ్రఫీ సేవా ఒప్పందం',
    customerInfo: 'కస్టమర్ సమాచారం',
    eventInfo: 'ఈవెంట్ సమాచారం',
    services: 'చేర్చబడిన సేవలు',
    deliverables: 'డెలివరబుల్స్',
    paymentSchedule: 'చెల్లింపు షెడ్యూల్',
    terms: 'నిబంధనలు & షరతులు',
    retention: 'డేటా నిల్వ',
    name: 'పేరు',
    email: 'ఇమెయిల్',
    phone: 'ఫోన్',
    event: 'ఈవెంట్',
    eventType: 'రకం',
    date: 'తేదీ',
    venue: 'వేదిక',
    milestone: 'మైలురాయి',
    amount: 'మొత్తం',
    dueDate: 'గడువు',
    status: 'స్థితి',
    statusPaid: 'చెల్లించారు',
    statusPending: 'పెండింగ్',
    statusOverdue: 'గడువు దాటింది',
    total: 'మొత్తం ప్యాకేజీ',
    retentionNote: 'డెలివరీ చేసిన ఫైల్స్‌ను డౌన్‌లోడ్ చేసి బ్యాకప్ చేయడం కస్టమర్ బాధ్యత.',
    acceptedBy: 'ఆమోదించినవారు',
    issuedBy: 'జారీ చేసినవారు',
    digitallyIssued: 'పంపేటప్పుడు డిజిటల్‌గా జారీ చేయబడింది — సంతకం అవసరం లేదు.',
    photographerRole: 'ఫోటోగ్రాఫర్ / స్టూడియో',
    agreementNo: 'ఒప్పంద సంఖ్య',
    on: 'తేదీన',
    version: 'వెర్షన్',
    qty: 'పరిమాణం',
    thankYouTitle: 'ధన్యవాదాలు',
    thankYouHeadline: 'ధన్యవాదాలు',
    thankYouBody: 'మీ బుకింగ్ నిర్ధారించబడింది మరియు ఈ ఒప్పందం సురక్షితంగా నమోదు చేయబడింది. మీ ప్రత్యేక క్షణాలను చిత్రీకరించడానికి మేము ఎదురుచూస్తున్నాము — తదుపరి దశల గురించి మీ ఫోటోగ్రాఫర్ మిమ్మల్ని సంప్రదిస్తారు.',
    thankYouSigned: 'ఈ సంతకం చేసిన కాపీని మీ రికార్డుల కోసం ఉంచుకోండి.',
    securelySigned: 'సురక్షితంగా సంతకం & నిల్వ చేయబడింది',
  },
  hi: {
    title: 'फ़ोटोग्राफ़ी सेवा अनुबंध',
    customerInfo: 'ग्राहक जानकारी',
    eventInfo: 'इवेंट जानकारी',
    services: 'शामिल सेवाएँ',
    deliverables: 'डिलिवरेबल्स',
    paymentSchedule: 'भुगतान अनुसूची',
    terms: 'नियम और शर्तें',
    retention: 'डेटा प्रतिधारण',
    name: 'नाम',
    email: 'ईमेल',
    phone: 'फ़ोन',
    event: 'इवेंट',
    eventType: 'प्रकार',
    date: 'तारीख़',
    venue: 'स्थल',
    milestone: 'मील का पत्थर',
    amount: 'राशि',
    dueDate: 'देय',
    status: 'स्थिति',
    statusPaid: 'भुगतान हो गया',
    statusPending: 'लंबित',
    statusOverdue: 'अतिदेय',
    total: 'कुल पैकेज',
    retentionNote: 'डिलीवर की गई फ़ाइलों को डाउनलोड और बैकअप करना ग्राहक की ज़िम्मेदारी है।',
    acceptedBy: 'स्वीकृत द्वारा',
    issuedBy: 'जारीकर्ता',
    digitallyIssued: 'भेजते समय डिजिटल रूप से जारी — हस्ताक्षर आवश्यक नहीं।',
    photographerRole: 'फ़ोटोग्राफ़र / स्टूडियो',
    agreementNo: 'अनुबंध संख्या',
    on: 'को',
    version: 'संस्करण',
    qty: 'मात्रा',
    thankYouTitle: 'धन्यवाद',
    thankYouHeadline: 'धन्यवाद',
    thankYouBody: 'आपकी बुकिंग पक्की हो गई है और यह अनुबंध सुरक्षित रूप से दर्ज कर लिया गया है। हम आपके ख़ास पलों को क़ैद करने के लिए उत्सुक हैं — अगले चरणों के बारे में आपके फ़ोटोग्राफ़र आपसे संपर्क करेंगे।',
    thankYouSigned: 'इस हस्ताक्षरित प्रति को अपने रिकॉर्ड के लिए सहेज कर रखें।',
    securelySigned: 'सुरक्षित रूप से हस्ताक्षरित और संग्रहीत',
  },
}

export const FRAMEDROPS_PROMO_URL = process.env.FRAMEDROPS_PROMO_URL || 'https://framedrops.in'

/** Convenience getter for a LangMap with safe fallback to English. */
export function tr(map, lang) {
  return map[lang] || map.en
}
