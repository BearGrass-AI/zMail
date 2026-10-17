//! Drive times from Apple Maps (MapKit): two place searches, then an ETA request. Built into
//! macOS, no API key. Nothing here uses the device's location, so there's no permission prompt.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Place {
    name: String,
    address: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Eta {
    from: Place,
    to: Place,
    seconds: f64,
    meters: f64,
}

const MAX_QUERY_CHARS: usize = 200;

/// A place query as typed by the model or the user: trimmed, non-empty, short, one line.
fn clean_query(q: &str) -> Result<String, String> {
    let q = q.trim();
    if q.is_empty() {
        return Err("empty place".into());
    }
    if q.chars().count() > MAX_QUERY_CHARS {
        return Err("place too long".into());
    }
    if q.chars().any(char::is_control) {
        return Err("place has control characters".into());
    }
    Ok(q.to_string())
}

/// An address on one line, as MapKit's placemark title gave it: a full address may put the
/// street, the city and the country on lines of their own.
#[cfg_attr(
    all(not(target_os = "macos"), not(test)),
    expect(dead_code, reason = "only MapKit's addresses need it")
)]
fn one_line(address: &str) -> String {
    address
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{Eta, Place};
    use block2::RcBlock;
    use objc2::AnyThread;
    use objc2::rc::Retained;
    use objc2_foundation::{NSDate, NSError, NSString};
    use objc2_map_kit::{
        MKDirections, MKDirectionsRequest, MKDirectionsTransportType, MKETAResponse, MKErrorCode,
        MKLocalSearch, MKLocalSearchRequest, MKLocalSearchResponse, MKMapItem,
    };
    use std::cell::RefCell;
    use std::sync::mpsc;
    use std::time::Duration;

    const STEP_TIMEOUT: Duration = Duration::from_secs(20);

    /// What the main thread reports: a `Step` per finished lookup, then `Done`.
    enum Msg {
        Step,
        Done(Result<Eta, String>),
    }

    pub async fn eta(
        app: tauri::AppHandle,
        from: String,
        to: String,
        depart_ms: Option<f64>,
    ) -> Result<Eta, String> {
        let (tx, rx) = mpsc::channel::<Msg>();
        // MapKit objects aren't Send, so they're made and used only on the main thread, whose
        // run loop also delivers their completion handlers. Only plain data comes back here.
        app.run_on_main_thread(move || start(from, to, depart_ms, tx))
            .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            loop {
                match rx.recv_timeout(STEP_TIMEOUT) {
                    Ok(Msg::Step) => continue,
                    Ok(Msg::Done(r)) => return r,
                    Err(_) => return Err("Apple Maps took too long".into()),
                }
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }

    fn start(from: String, to: String, depart_ms: Option<f64>, tx: mpsc::Sender<Msg>) {
        search(from.clone(), move |a| {
            let a = match a {
                Ok(a) => a,
                Err(e) => return drop(tx.send(Msg::Done(Err(e)))),
            };
            let _ = tx.send(Msg::Step);
            search(to.clone(), move |b| {
                let b = match b {
                    Ok(b) => b,
                    Err(e) => return drop(tx.send(Msg::Done(Err(e)))),
                };
                let _ = tx.send(Msg::Step);
                let (pa, pb) = (place(&a, &from), place(&b, &to));
                directions(&a, &b, depart_ms, move |r| {
                    let r = r.map(|(seconds, meters)| Eta {
                        from: pa,
                        to: pb,
                        seconds,
                        meters,
                    });
                    let _ = tx.send(Msg::Done(r));
                });
            });
        });
    }

    /// Calls `f` at most once, however often MapKit calls the block.
    fn once<T>(f: impl FnOnce(T)) -> impl Fn(T) {
        let f = RefCell::new(Some(f));
        move |v| {
            if let Some(f) = f.borrow_mut().take() {
                f(v)
            }
        }
    }

    /// MapKit's error, unless it's the plain "not found" one, which gets `msg` instead.
    fn failure(err: Option<&NSError>, not_found: MKErrorCode, msg: String) -> String {
        match err {
            Some(e) if usize::try_from(e.code()).ok() != Some(not_found.0) => {
                format!("Apple Maps: {}", e.localizedDescription())
            }
            _ => msg,
        }
    }

    /// The first Apple Maps result for a natural-language query.
    fn search(query: String, on_done: impl FnOnce(Result<Retained<MKMapItem>, String>) + 'static) {
        let on_done = once(on_done);
        // SAFETY: object creation on the main thread, which `eta` guarantees.
        let request = unsafe { MKLocalSearchRequest::new() };
        // SAFETY: a property set on a request this function owns.
        unsafe { request.setNaturalLanguageQuery(Some(&NSString::from_str(&query))) };
        // SAFETY: a fresh allocation initialised with a live request.
        let search = unsafe { MKLocalSearch::initWithRequest(MKLocalSearch::alloc(), &request) };
        // Keep the search alive until its handler has run, then let it go.
        let keep = RefCell::new(Some(search.clone()));
        let block = RcBlock::new(move |resp: *mut MKLocalSearchResponse, err: *mut NSError| {
            // SAFETY: MapKit passes null or valid objects that live for the duration of the call.
            let (resp, err) = unsafe { (resp.as_ref(), err.as_ref()) };
            // SAFETY: a property read on the live response.
            let item = resp.and_then(|r| unsafe { r.mapItems() }.firstObject());
            on_done(item.ok_or_else(|| {
                failure(
                    err,
                    MKErrorCode::PlacemarkNotFound,
                    format!("Apple Maps couldn't find \"{query}\""),
                )
            }));
            keep.borrow_mut().take();
        });
        // SAFETY: the block matches MapKit's completion signature and is retained by the search;
        // this runs on the main thread, whose run loop delivers the handler.
        unsafe { search.startWithCompletionHandler(RcBlock::as_ptr(&block)) };
    }

    /// Driving (seconds, meters) between two map items, leaving at `depart_ms` or now.
    fn directions(
        a: &MKMapItem,
        b: &MKMapItem,
        depart_ms: Option<f64>,
        on_done: impl FnOnce(Result<(f64, f64), String>) + 'static,
    ) {
        let on_done = once(on_done);
        // SAFETY: object creation on the main thread, which `eta` guarantees.
        let request = unsafe { MKDirectionsRequest::new() };
        // SAFETY: property sets on a request this function owns, with live map items.
        unsafe {
            request.setSource(Some(a));
            request.setDestination(Some(b));
            request.setTransportType(MKDirectionsTransportType::Automobile);
        }
        if let Some(ms) = depart_ms.filter(|ms| ms.is_finite()) {
            let date = NSDate::dateWithTimeIntervalSince1970(ms / 1000.0);
            // SAFETY: as above.
            unsafe { request.setDepartureDate(Some(&date)) };
        }
        // SAFETY: a fresh allocation initialised with a live request.
        let directions = unsafe { MKDirections::initWithRequest(MKDirections::alloc(), &request) };
        let keep = RefCell::new(Some(directions.clone()));
        let block = RcBlock::new(move |resp: *mut MKETAResponse, err: *mut NSError| {
            // SAFETY: MapKit passes null or valid objects that live for the duration of the call.
            let (resp, err) = unsafe { (resp.as_ref(), err.as_ref()) };
            // SAFETY: property reads on the live response.
            let eta = resp.map(|r| unsafe { (r.expectedTravelTime(), r.distance()) });
            on_done(eta.ok_or_else(|| {
                failure(
                    err,
                    MKErrorCode::DirectionsNotFound,
                    "Apple Maps couldn't find a driving route".into(),
                )
            }));
            keep.borrow_mut().take();
        });
        // SAFETY: as in `search`: a matching block, kept alive, delivered on the main run loop.
        unsafe { directions.calculateETAWithCompletionHandler(RcBlock::as_ptr(&block)) };
    }

    fn place(item: &MKMapItem, query: &str) -> Place {
        // SAFETY: property reads on a map item MapKit returned.
        let name = unsafe { item.name() }.map_or_else(|| query.to_string(), |s| s.to_string());
        // SAFETY: as above, then a property read on the address MapKit returned with it.
        let address = unsafe { item.address().map(|a| a.fullAddress().to_string()) }
            .map(|a| super::one_line(&a))
            .filter(|a| !a.is_empty() && *a != name);
        Place { name, address }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::Eta;

    pub async fn eta(
        _app: tauri::AppHandle,
        _from: String,
        _to: String,
        _depart_ms: Option<f64>,
    ) -> Result<Eta, String> {
        Err("Drive times need macOS".into())
    }
}

/// Driving time between two places Apple Maps can find ("123 Main St, Denver CO",
/// "The Lakeside Inn, Lake Placid"), leaving at `depart_ms` (Unix ms) or now.
#[tauri::command]
pub async fn travel_eta(
    app: tauri::AppHandle,
    from: String,
    to: String,
    depart_ms: Option<f64>,
) -> Result<Eta, String> {
    let from = clean_query(&from)?;
    let to = clean_query(&to)?;
    imp::eta(app, from, to, depart_ms).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_clean_query() {
        assert_eq!(
            clean_query("  The Lakeside, Lake Placid NY \n"),
            Ok("The Lakeside, Lake Placid NY".into())
        );
        assert_eq!(clean_query("   "), Err("empty place".into()));
        assert_eq!(clean_query(&"a".repeat(201)), Err("place too long".into()));
        assert!(clean_query(&"é".repeat(200)).is_ok());
        assert_eq!(
            clean_query("Main St\nDenver"),
            Err("place has control characters".into())
        );
        assert_eq!(
            clean_query("Main\u{0}St"),
            Err("place has control characters".into())
        );
    }

    #[test]
    fn maps_addresses_read_on_one_line() {
        assert_eq!(
            one_line("12 Example Ave\nExampleton, EX 00000\nExampleland"),
            "12 Example Ave, Exampleton, EX 00000, Exampleland"
        );
        assert_eq!(
            one_line("12 Example Ave, Exampleton"),
            "12 Example Ave, Exampleton"
        );
        assert_eq!(
            one_line(" 12 Example Ave \r\n\n Exampleton "),
            "12 Example Ave, Exampleton"
        );
        assert_eq!(one_line(" \n "), "");
    }

    #[test]
    fn maps_eta_serializes_camel_case() {
        let eta = Eta {
            from: Place {
                name: "Home".into(),
                address: None,
            },
            to: Place {
                name: "The Lakeside".into(),
                address: Some("650 E 3rd St".into()),
            },
            seconds: 9060.0,
            meters: 160934.0,
        };
        let v = serde_json::to_value(&eta).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "from": { "name": "Home", "address": null },
                "to": { "name": "The Lakeside", "address": "650 E 3rd St" },
                "seconds": 9060.0,
                "meters": 160934.0
            })
        );
    }
}
