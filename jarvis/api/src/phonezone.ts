// A best guess at someone's time zone from their phone number, for people who
// text OVOA before the app has ever told us theirs (a trial guest, or someone
// who linked a number and never opened the app). Without it the zone was UTC,
// so a guest texting at 10 pm in New York was told "it's 2 AM, late night"
// (real texts, 2026-09-29). An hour off is fine; the app's own zone replaces it.

const NANP: Record<string, string[]> = {
  "America/New_York": [
    "201 202 203 207 212 215 216 220 226 227 229 231 234 239 240 248 267 272 276 289 301 302 304 305 313 315 321 326 330 339 343 347 351 352 365 367 386 401 404 407 410 412 413 416 418 419 423 434 437 438 440 443 445 447 448 470 475 478 484 502 508 513 514 516 517 518 519 540 548 551 561 567 570 571 574 581 585 586 603 607 609 610 613 614 616 617 631 646 647 656 667 678 703 704 705 706 716 717 718 724 727 732 740 754 757 762 765 771 772 774 781 786 802 803 804 807 813 814 819 828 835 838 843 845 848 854 856 857 859 860 862 863 864 865 878 904 905 908 910 912 914 917 919 929 937 941 947 954 959 973 978 980 984",
  ],
  "America/Chicago": [
    "204 205 210 214 217 218 224 225 228 251 254 256 262 270 281 309 312 314 316 318 319 320 331 334 337 346 361 402 405 409 414 430 431 432 469 501 504 507 512 515 531 534 563 573 580 601 605 608 612 615 618 620 630 636 639 641 651 660 662 682 708 712 713 715 731 737 763 769 773 779 815 816 817 830 832 847 870 872 901 903 913 918 920 931 936 940 952 956 972 979 985",
    "306",
  ],
  "America/Denver": ["208 303 307 385 403 406 435 505 575 587 719 720 780 801 825 915 970 983"],
  "America/Phoenix": ["480 520 602 623 928"],
  "America/Los_Angeles": [
    "206 209 213 236 250 253 279 310 323 341 360 408 415 424 425 442 503 509 510 530 541 559 562 604 619 626 628 650 657 661 669 672 707 714 725 747 760 775 778 805 818 831 858 909 916 925 949 951 971",
  ],
  "America/Anchorage": ["907"],
  "Pacific/Honolulu": ["808"],
  "America/Halifax": ["902 506 782"],
  "America/St_Johns": ["709"],
};

const COUNTRY: Record<string, string> = {
  "20": "Africa/Cairo", "27": "Africa/Johannesburg", "31": "Europe/Amsterdam", "32": "Europe/Brussels",
  "33": "Europe/Paris", "34": "Europe/Madrid", "39": "Europe/Rome", "41": "Europe/Zurich", "43": "Europe/Vienna",
  "44": "Europe/London", "45": "Europe/Copenhagen", "46": "Europe/Stockholm", "47": "Europe/Oslo", "48": "Europe/Warsaw",
  "49": "Europe/Berlin", "51": "America/Lima", "52": "America/Mexico_City", "54": "America/Argentina/Buenos_Aires",
  "55": "America/Sao_Paulo", "56": "America/Santiago", "57": "America/Bogota", "60": "Asia/Kuala_Lumpur",
  "61": "Australia/Sydney", "62": "Asia/Jakarta", "63": "Asia/Manila", "64": "Pacific/Auckland", "65": "Asia/Singapore",
  "66": "Asia/Bangkok", "81": "Asia/Tokyo", "82": "Asia/Seoul", "84": "Asia/Ho_Chi_Minh", "86": "Asia/Shanghai",
  "90": "Europe/Istanbul", "91": "Asia/Kolkata", "92": "Asia/Karachi", "7": "Europe/Moscow",
  "234": "Africa/Lagos", "254": "Africa/Nairobi", "351": "Europe/Lisbon", "353": "Europe/Dublin", "380": "Europe/Kyiv",
  "852": "Asia/Hong_Kong", "886": "Asia/Taipei", "966": "Asia/Riyadh", "971": "Asia/Dubai", "972": "Asia/Jerusalem",
};

const AREA = new Map<string, string>();
for (const [zone, lists] of Object.entries(NANP)) for (const code of lists.join(" ").split(" ")) AREA.set(code, zone);

/** The IANA zone a phone number most likely lives in, or null when it can't be told (a made-up 555 number, an unlisted country). Pure. */
export function zoneForPhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("1") && digits.length === 11) return AREA.get(digits.slice(1, 4)) ?? null;
  for (const len of [3, 2, 1]) {
    const zone = COUNTRY[digits.slice(0, len)];
    if (zone) return zone;
  }
  return null;
}
