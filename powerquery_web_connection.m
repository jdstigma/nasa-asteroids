// ─────────────────────────────────────────────────────────────────────────
// Power BI — Web connection to the flattened asteroid data on GitHub
//
// HOW TO USE:
//   1. Power BI Desktop → Home → Get data → Blank query
//   2. Home → Advanced Editor
//   3. Delete everything, paste this whole script, click Done
//   4. Home → Close & Apply
// ─────────────────────────────────────────────────────────────────────────
let
    Source = Csv.Document(
        Web.Contents("https://raw.githubusercontent.com/jdstigma/nasa-asteroids/main/asteroids_flat.csv"),
        [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]
    ),

    Promoted = Table.PromoteHeaders(Source, [PromoteAllScalars = true]),

    Typed = Table.TransformColumnTypes(Promoted, {
        {"id",                       Int64.Type},
        {"neo_id",                   type text},
        {"name",                     type text},
        {"short_name",               type text},
        {"designation",              type text},
        {"magnitude",                type number},
        {"potentially_hazardous",    type logical},
        {"diameter_min_m",           type number},
        {"diameter_max_m",           type number},
        {"eccentricity",             type number},
        {"semi_major_axis",          type number},
        {"inclination",              type number},
        {"ascending_node_longitude", type number},
        {"orbital_period",           type number},
        {"perihelion_distance",      type number},
        {"perihelion_argument",      type number},
        {"aphelion_distance",        type number},
        {"mean_anomaly",             type number},
        {"mean_motion",              type number},
        {"orbit_class_type",         type text},
        {"orbit_class_desc",         type text},
        {"first_observation_date",   type date},
        {"last_observation_date",    type date},
        {"data_arc_days",            Int64.Type},
        {"orbit_uncertainty",        type text},
        {"min_orbit_intersection",   type number},
        {"jupiter_tisserand",        type number},
        {"close_approach_date",      type date},
        {"close_approach_date_full", type text},
        {"epoch_ms",                 Int64.Type},
        {"velocity_km_s",            type number},
        {"velocity_km_h",            type number},
        {"miss_distance_au",         type number},
        {"miss_distance_lunar",      type number},
        {"miss_distance_km",         type number},
        {"orbiting_body",            type text}
    }),

    // Helpful derived columns for slicers / filtering in the report
    WithYear = Table.AddColumn(Typed, "approach_year",
        each if [close_approach_date] = null then null else Date.Year([close_approach_date]), Int64.Type),

    WithMissLunarBand = Table.AddColumn(WithYear, "miss_distance_band",
        each
            if [miss_distance_lunar] = null then "Unknown"
            else if [miss_distance_lunar] < 1  then "< 1 lunar distance"
            else if [miss_distance_lunar] < 5  then "1–5 lunar distances"
            else if [miss_distance_lunar] < 20 then "5–20 lunar distances"
            else "> 20 lunar distances",
        type text)
in
    WithMissLunarBand
