// Funktion 1: Titel-Animation beim Laden der Seite
function animateTitle() {
    const title = document.getElementById('main-title');
    if (title) {
        title.classList.add('loaded');
    }
}

// Funktion 2: Scroll-Animation für Sektionen & Kacheln
const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            // Wenn der quad-wrapper sichtbar wird, starte die Kachel-Animation
            if (entry.target.classList.contains('quad-wrapper')) {
                animateTiles();
                // Optional: Stoppe die Beobachtung des Wrappers, nachdem er einmal animiert wurde
                observer.unobserve(entry.target);
            }
        }
    });
}, {
    threshold: 0.1
});

// Funktion 3: Kachel-Animation (zeitverzögertes Erscheinen mit Fly-in)
function animateTiles() {
    const tiles = document.querySelectorAll('.quad-tile');

    tiles.forEach((tile, index) => {
        // Nur animieren, wenn die Kachel noch nicht sichtbar ist
        if (!tile.classList.contains('visible')) {
            // Füge die Klasse 'visible' mit einer Verzögerung hinzu
            // Das löst den Übergang vom Startzustand (z.B. translateX(-100%)) zum Endzustand (translate(0,0)) aus.
            setTimeout(() => {
                tile.classList.add('visible');
            }, index * 200); // 200ms Verzögerung zwischen den Kacheln
        }
    });
}

// Alle Elemente, die beim Scrollen animiert werden sollen
const elementsToFadeIn = document.querySelectorAll('.fade-in');
elementsToFadeIn.forEach(el => observer.observe(el));
