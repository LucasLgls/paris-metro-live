import { useEffect } from "react";
import { Link } from "react-router-dom";

export function Credits() {
  useEffect(() => {
    document.documentElement.lang = "en";
    document.title = "Data credits — Paris Transit Live";
  }, []);

  return (
    <main className="credits-page">
      <article className="credits-card">
        <Link className="credits-back" to="/">
          ← Return to the map
        </Link>
        <h1>Data credits</h1>
        <p>
          Paris Transit Live combines public transport and map datasets. It is not affiliated with
          Île-de-France Mobilités or RATP.
        </p>

        <h2>Transit data</h2>
        <p>
          Source: Île-de-France Mobilités — Open Data PRIM. Timetable and station data come from the{" "}
          <a
            href="https://prim.iledefrance-mobilites.fr/jeux-de-donnees/offre-horaires-tc-gtfs-idfm"
            rel="noreferrer"
          >
            IDFM GTFS dataset
          </a>{" "}
          under the{" "}
          <a href="https://prim.iledefrance-mobilites.fr/fr/licences" rel="noreferrer">
            Licence Mobilité
          </a>
          . Line geometry comes from the{" "}
          <a
            href="https://prim.iledefrance-mobilites.fr/fr/jeux-de-donnees/traces-des-lignes-de-transport-en-commun-idfm"
            rel="noreferrer"
          >
            IDFM line-trace dataset
          </a>{" "}
          under the Open Database Licence. The transformed public network data can be downloaded as{" "}
          <a href="/api/v1/network/manifest">JSON</a>.
        </p>
        <p>
          Realtime passage predictions come from the{" "}
          <a
            href="https://prim.iledefrance-mobilites.fr/fr/apis/idfm-ivtr-requete_globale"
            rel="noreferrer"
          >
            PRIM global next-passages API
          </a>
          . The catalogue labels it Licence Mobilité and its API terms identify ODbL for the
          returned data; this project follows the attribution and share-alike conditions of both.
        </p>
        <p>
          Train positions are estimates from platform countdowns and the timetable. They are not
          reported GPS locations. When live data pauses, trains are dimmed and hold their last
          estimated position.
        </p>

        <h2>Basemap</h2>
        <p>
          Map data ©{" "}
          <a href="https://www.openstreetmap.org/copyright" rel="noreferrer">
            OpenStreetMap contributors
          </a>
          , available under the Open Database Licence. The self-hosted Paris extract was produced
          with{" "}
          <a href="https://protomaps.com/" rel="noreferrer">
            Protomaps
          </a>{" "}
          and PMTiles. Protomaps publishes the archive as an ODbL Produced Work. Its basemap style
          is CC0. The{" "}
          <a href="https://github.com/protomaps/basemaps/blob/main/LICENSE.md" rel="noreferrer">
            Protomaps basemap
          </a>
          ,{" "}
          <a href="https://github.com/protomaps/PMTiles/blob/main/LICENSE" rel="noreferrer">
            PMTiles
          </a>
          , and{" "}
          <a
            href="https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt"
            rel="noreferrer"
          >
            MapLibre GL JS
          </a>{" "}
          software notices are available from their maintainers.
        </p>
        <p>
          Land-cover data: © ESA WorldCover project 2020 / Contains modified Copernicus Sentinel
          data (2020) processed by the ESA WorldCover consortium, available under CC BY 4.0.
        </p>

        <h2>Source and corrections</h2>
        <p>
          Source dates, checksums, and transformation notes are maintained with the application’s
          network artifact. Data or attribution corrections can be reported through the project
          repository.
        </p>
      </article>
    </main>
  );
}
