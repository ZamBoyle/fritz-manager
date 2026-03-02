# Fritz!Box Control Panel

Tableau de bord web pour gérer les appareils, le contrôle parental et le monitoring réseau d'une Fritz!Box.

![Dark Theme](https://img.shields.io/badge/theme-dark-1a1d2e)
![Node.js](https://img.shields.io/badge/node-18%2B-green)
![Fritz!OS](https://img.shields.io/badge/Fritz!OS-7.x%20%7C%208.x-red)

## Fonctionnalités

### Appareils
- Liste des appareils connectés (IP, MAC, WiFi/Ethernet, débit)
- Filtrage : tous, favoris, en ligne
- Suppression des appareils hors ligne (individuelle ou en masse)
- Dernière connexion (last seen) pour les appareils hors ligne
- Indicateur visuel si l'appareil est bloqué (via contrôle parental)

### Contrôle parental
- **Profils** : création, édition, suppression de profils de filtrage
  - Plages horaires d'accès internet (grille hebdomadaire)
  - Budget temps quotidien par appareil
  - Listes noires / blanches de sites web (max 500 entrées)
- **Appareils** : assignation d'un profil par appareil, blocage individuel

### Monitoring
- Suivi en temps réel du statut en ligne/hors ligne
- Temps d'utilisation quotidien et total (rolling 30 jours)
- Historique d'utilisation sur 7 jours (barres visuelles)
- Filtrage par profil
- Rafraîchissement automatique toutes les 15s

## Stack technique

| Composant | Technologie |
|-----------|-------------|
| Backend | Node.js + Express |
| Frontend | Vanilla HTML/CSS/JS (dark theme) |
| Auth Fritz!Box | PBKDF2 challenge-response (`login_sid.lua`) |
| API Fritz!Box | TR-064 SOAP (port 49000) + `data.lua` / `query.lua` |
| Sécurité | Helmet, CSP, sanitization des entrées |

## Installation

```bash
git clone <repo-url>
cd FritzBox
npm install
```

## Configuration

Créer un fichier `.env` à la racine :

```env
FRITZ_HOST=192.168.178.1
FRITZ_USER=admin
FRITZ_PASSWORD=motdepasse
PORT=3000
```

| Variable | Description | Défaut |
|----------|-------------|--------|
| `FRITZ_HOST` | IP de la Fritz!Box | `192.168.178.1` |
| `FRITZ_USER` | Nom d'utilisateur admin | _(vide)_ |
| `FRITZ_PASSWORD` | Mot de passe admin | **requis** |
| `PORT` | Port du serveur local | `3000` |

## Lancement

```bash
# Production
npm start

# Développement (auto-reload)
npm run dev
```

Ouvrir `http://localhost:3000` dans le navigateur.

## Structure du projet

```
├── server.js                 # Serveur Express + routes API
├── src/fritzbox/
│   ├── auth.js               # Authentification PBKDF2/MD5
│   ├── soap.js               # Client TR-064 SOAP + Digest Auth
│   ├── hosts.js              # Énumération des appareils
│   ├── filter.js             # Contrôle parental + parsing HTML
│   └── monitor.js            # Suivi de sessions + analytics
├── public/
│   ├── index.html            # SPA (login + 3 onglets)
│   ├── css/style.css         # Dark theme
│   └── js/
│       ├── app.js            # Core : login, routing, API client
│       ├── devices.js        # Gestion des appareils
│       ├── filters.js        # Interface contrôle parental
│       ├── profiles.js       # Éditeur de profils
│       └── monitor.js        # Interface monitoring
```

## API endpoints

<details>
<summary>Voir tous les endpoints</summary>

### Authentification
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/api/login` | Connexion à la Fritz!Box |
| GET | `/api/status` | Statut de la connexion |
| POST | `/api/logout` | Déconnexion |

### Appareils
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/devices` | Liste des appareils |
| GET | `/api/devices/:ip/status` | Statut WAN d'un appareil |
| POST | `/api/devices/:ip/block` | Bloquer l'accès WAN (TR-064) |
| POST | `/api/devices/:ip/unblock` | Débloquer l'accès WAN (TR-064) |
| POST | `/api/devices/remove` | Supprimer un appareil |
| POST | `/api/devices/cleanup` | Supprimer tous les inactifs |

### Contrôle parental
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/filters` | Appareils + profils |
| POST | `/api/filters/block` | Bloquer/débloquer un appareil |
| POST | `/api/filters/profile` | Assigner un profil |

### Profils
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/profiles` | Liste des profils |
| GET | `/api/profiles/:id` | Détail d'un profil |
| POST | `/api/profiles` | Créer un profil |
| PUT | `/api/profiles/:id` | Modifier un profil |
| DELETE | `/api/profiles/:id` | Supprimer un profil |
| GET | `/api/profiles/meta` | Métadonnées locales (icônes) |
| POST | `/api/profiles/meta` | Sauvegarder les métadonnées |
| GET | `/api/profiles/websites/:type` | Liste noire/blanche |
| PUT | `/api/profiles/websites/:type` | Modifier la liste |

### Monitoring
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/api/monitor/start` | Démarrer le suivi |
| POST | `/api/monitor/stop` | Arrêter le suivi |
| GET | `/api/monitor/status` | Stats de tous les appareils |
| GET | `/api/monitor/profile/:profileId` | Stats par profil |
| POST | `/api/monitor/reset` | Réinitialiser les données |

### Favoris
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/favorites` | Liste des favoris |
| POST | `/api/favorites` | Sauvegarder les favoris |

</details>

## Notes techniques

- Le SID Fritz!Box expire après **20 minutes** (renouvelé automatiquement)
- Le cache des données parentales dure **30s** pour limiter les requêtes
- La page `kidLis` retourne du **HTML** (pas du JSON) — parsing par regex
- La suppression d'un appareil nécessite une **confirmation en 2 étapes**
- Les données de monitoring sont conservées **30 jours** (rolling)

## Licence

ISC
