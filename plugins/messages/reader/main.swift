// A sandboxed reader for the database of the macOS Messages app.
// The user selects the folder ~/Library/Messages one time, so the terminal app needs no Full Disk Access.

import AppKit
import SQLite3

let bookmarkKey = "bookmark"
let noAccess: Int32 = 2

func fail(_ text: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((text + "\n").utf8))
    exit(code)
}

// In the sandbox, NSHomeDirectory() is the container of the app.
func realHome() -> String {
    String(cString: getpwuid(getuid()).pointee.pw_dir)
}

func grant() {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.activate(ignoringOtherApps: true)
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.showsHiddenFiles = true
    let wanted = URL(fileURLWithPath: realHome() + "/Library/Messages")
    panel.directoryURL = wanted
    panel.message = "Select the folder Messages. The reader gets read access to the message history."
    panel.prompt = "Give read access"
    guard panel.runModal() == .OK, let url = panel.url else { fail("no folder was selected") }
    guard url.resolvingSymlinksInPath().path == wanted.resolvingSymlinksInPath().path else {
        fail("select the folder \(wanted.path), not \(url.path)")
    }
    do {
        let data = try url.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess],
                                        includingResourceValuesForKeys: nil, relativeTo: nil)
        UserDefaults.standard.set(data, forKey: bookmarkKey)
        UserDefaults.standard.synchronize()
        print("read access to \(url.path) is saved")
    } catch {
        fail("cannot save the access: \(error.localizedDescription)")
    }
}

func grantedDatabase() -> String {
    guard let data = UserDefaults.standard.data(forKey: bookmarkKey) else {
        fail("no read access to Messages", code: noAccess)
    }
    var stale = false
    guard let folder = try? URL(resolvingBookmarkData: data, options: [.withSecurityScope], relativeTo: nil,
                                bookmarkDataIsStale: &stale),
          folder.startAccessingSecurityScopedResource() else {
        fail("the saved read access to Messages is not valid", code: noAccess)
    }
    return folder.appendingPathComponent("chat.db").path
}

func openDatabase(_ path: String) -> OpaquePointer {
    let name = "file:" + (path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path) + "?mode=ro"
    var db: OpaquePointer?
    guard sqlite3_open_v2(name, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK, let db,
          sqlite3_exec(db, "SELECT 1 FROM message LIMIT 1", nil, nil, nil) == SQLITE_OK else {
        fail("cannot read \(path): \(db.map { String(cString: sqlite3_errmsg($0)) } ?? "no database")", code: noAccess)
    }
    return db
}

let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

func run(_ db: OpaquePointer, _ request: [String: Any]) throws -> [String: Any] {
    guard let sql = request["sql"] as? String else { throw Failure("the request has no sql") }
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
        throw Failure(String(cString: sqlite3_errmsg(db)))
    }
    defer { sqlite3_finalize(statement) }
    guard sqlite3_stmt_readonly(statement) != 0 else { throw Failure("the statement is not read-only") }
    let args = (request["args"] as? [Any]) ?? []
    guard Int(sqlite3_bind_parameter_count(statement)) == args.count else {
        throw Failure("the statement and the request have a different number of values")
    }
    for (index, value) in args.enumerated() {
        let at = Int32(index + 1)
        switch value {
        case let text as String: sqlite3_bind_text(statement, at, text, -1, transient)
        case let number as NSNumber where CFNumberIsFloatType(number): sqlite3_bind_double(statement, at, number.doubleValue)
        case let number as NSNumber: sqlite3_bind_int64(statement, at, number.int64Value)
        default: sqlite3_bind_null(statement, at)
        }
    }
    let count = sqlite3_column_count(statement)
    let columns = (0..<count).map { String(cString: sqlite3_column_name(statement, $0)) }
    var rows: [[Any]] = []
    while true {
        let code = sqlite3_step(statement)
        if code == SQLITE_DONE { break }
        guard code == SQLITE_ROW else { throw Failure(String(cString: sqlite3_errmsg(db))) }
        rows.append((0..<count).map { column -> Any in
            switch sqlite3_column_type(statement, column) {
            case SQLITE_INTEGER: return sqlite3_column_int64(statement, column)
            case SQLITE_FLOAT: return sqlite3_column_double(statement, column)
            case SQLITE_TEXT: return String(cString: sqlite3_column_text(statement, column))
            case SQLITE_BLOB:
                let size = Int(sqlite3_column_bytes(statement, column))
                let bytes = sqlite3_column_blob(statement, column).map { Data(bytes: $0, count: size) } ?? Data()
                return ["blob": bytes.base64EncodedString()]
            default: return NSNull()
            }
        })
    }
    return ["columns": columns, "rows": rows]
}

struct Failure: Error {
    let text: String
    init(_ text: String) { self.text = text }
}

// Each input line is {"sql": ..., "args": [...]}. Each output line is {"columns": [...], "rows": [...]} or {"error": ...}.
func serve(_ path: String) {
    let db = openDatabase(path)
    while let line = readLine(strippingNewline: true) {
        var answer: [String: Any]
        do {
            guard let request = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
                throw Failure("the request is not a JSON object")
            }
            answer = try run(db, request)
        } catch let failure as Failure {
            answer = ["error": failure.text]
        } catch {
            answer = ["error": error.localizedDescription]
        }
        var out = (try? JSONSerialization.data(withJSONObject: answer)) ?? Data("{\"error\":\"cannot encode the rows\"}".utf8)
        out.append(0x0a)
        FileHandle.standardOutput.write(out)
    }
}

switch CommandLine.arguments.dropFirst().first {
case "grant": grant()
// A path is for the tests. The sandbox refuses a path outside the container and the folder that the user selected.
case "serve": serve(CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : grantedDatabase())
default: fail("usage: reader grant | serve [DATABASE]")
}
