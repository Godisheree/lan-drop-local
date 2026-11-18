//! Port & pencatat nilai yang berubah saat runtime.
//!
//! Node menulis port hasil retry ke `server/ports.js` (objek yang di-mutasi).
//! Di sini bentuknya sama: satu `Ports` dibagi ke discovery dan transfer, jadi
//! announce ke peer, `/status`, dan dashboard selalu menyebut port yang
//! benar-benar listen, bukan angka default yang kebetulan sudah dipakai.

use std::sync::atomic::{AtomicU16, Ordering};

pub struct Ports {
    pub http: AtomicU16,
    pub transfer: AtomicU16,
}

impl Ports {
    pub fn new(http: u16, transfer: u16) -> Ports {
        Ports {
            http: AtomicU16::new(http),
            transfer: AtomicU16::new(transfer),
        }
    }

    pub fn http(&self) -> u16 {
        self.http.load(Ordering::SeqCst)
    }

    pub fn transfer(&self) -> u16 {
        self.transfer.load(Ordering::SeqCst)
    }

    pub fn set_http(&self, port: u16) {
        self.http.store(port, Ordering::SeqCst);
    }

    pub fn set_transfer(&self, port: u16) {
        self.transfer.store(port, Ordering::SeqCst);
    }
}
