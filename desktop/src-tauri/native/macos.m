#import <AppKit/AppKit.h>
// Observers live for the application lifetime. Notifications carry no data into Rust.
void nedra_observe_lock(void (*lock)(void)) {
    NSNotificationCenter *workspace = NSWorkspace.sharedWorkspace.notificationCenter;
    for (NSString *name in @[NSWorkspaceWillSleepNotification,
                            NSWorkspaceScreensDidSleepNotification,
                            NSWorkspaceSessionDidResignActiveNotification]) {
        [workspace addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification * _Nonnull note) { (void)note; lock(); }];
    }
    // This system notification is not a documented API. Screen sleep and
    // session resignation above are supported fallbacks; it can only lock.
    [NSDistributedNotificationCenter.defaultCenter addObserverForName:@"com.apple.screenIsLocked"
        object:nil queue:nil usingBlock:^(NSNotification * _Nonnull note) { (void)note; lock(); }];
}
long nedra_clipboard_generation(void) {
    @autoreleasepool { return NSPasteboard.generalPasteboard.changeCount; }
}

#if NEDRA_QA
static NSView *nedra_qa_webview(NSView *view) {
    Class webViewClass = NSClassFromString(@"WKWebView");
    if (webViewClass != Nil && [view isKindOfClass:webViewClass]) return view;
    for (NSView *child in view.subviews) {
        NSView *webView = nedra_qa_webview(child);
        if (webView != nil) return webView;
    }
    return nil;
}
void nedra_test_sleep_notification(void) {
    [NSWorkspace.sharedWorkspace.notificationCenter postNotificationName:NSWorkspaceWillSleepNotification object:NSWorkspace.sharedWorkspace];
}
static bool nedra_qa_key(CGKeyCode keyCode) {
    __block bool sent = false;
    void (^press)(void) = ^{
        NSWindow *window = nil;
        CGFloat largestArea = 0;
        for (NSWindow *candidate in NSApp.windows) {
            CGFloat area = NSWidth(candidate.frame) * NSHeight(candidate.frame);
            if (candidate.isVisible && area > largestArea) {
                window = candidate;
                largestArea = area;
            }
        }
        NSView *webView = window == nil ? nil : nedra_qa_webview(window.contentView);
        if (webView == nil) return;
        NSResponder *first = window.firstResponder;
        if ((![first isKindOfClass:NSView.class] || ![(NSView *)first isDescendantOf:webView])
            && ![window makeFirstResponder:webView]) return;
        CGEventRef down = CGEventCreateKeyboardEvent(NULL, keyCode, true);
        CGEventRef up = CGEventCreateKeyboardEvent(NULL, keyCode, false);
        if (down == NULL || up == NULL) {
            if (down != NULL) CFRelease(down);
            if (up != NULL) CFRelease(up);
            return;
        }
        [window makeKeyAndOrderFront:nil];
        pid_t pid = NSProcessInfo.processInfo.processIdentifier;
        CGEventPostToPid(pid, down);
        CGEventPostToPid(pid, up);
        CFRelease(down);
        CFRelease(up);
        sent = true;
    };
    if (NSThread.isMainThread) press(); else dispatch_sync(dispatch_get_main_queue(), press);
    return sent;
}
bool nedra_qa_tab(void) { return nedra_qa_key(48); }
bool nedra_qa_activate(void) { return nedra_qa_key(49); }
bool nedra_qa_click(double x, double y) {
    __block bool sent = false;
    void (^click)(void) = ^{
        NSWindow *window = nil;
        CGFloat largestArea = 0;
        for (NSWindow *candidate in NSApp.windows) {
            CGFloat area = NSWidth(candidate.frame) * NSHeight(candidate.frame);
            if (candidate.isVisible && area > largestArea) {
                window = candidate;
                largestArea = area;
            }
        }
        if (window == nil) return;
        NSView *webView = nedra_qa_webview(window.contentView);
        if (webView == nil || x < 0 || y < 0 || x >= NSWidth(webView.bounds) || y >= NSHeight(webView.bounds)) return;
        NSPoint local = NSMakePoint(x, webView.isFlipped ? y : NSHeight(webView.bounds) - y);
        if ([webView hitTest:local] == nil) return;
        NSPoint windowPoint = [webView convertPoint:local toView:nil];
        [window makeKeyAndOrderFront:nil];
        NSTimeInterval timestamp = NSProcessInfo.processInfo.systemUptime;
        NSEvent *down = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown
            location:windowPoint modifierFlags:0 timestamp:timestamp
            windowNumber:window.windowNumber context:nil eventNumber:0
            clickCount:1 pressure:1.0];
        NSEvent *up = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp
            location:windowPoint modifierFlags:0 timestamp:timestamp + 0.01
            windowNumber:window.windowNumber context:nil eventNumber:0
            clickCount:1 pressure:0.0];
        if (down == nil || up == nil) return;
        [NSApp postEvent:down atStart:NO];
        [NSApp postEvent:up atStart:NO];
        sent = true;
    };
    if (NSThread.isMainThread) click(); else dispatch_sync(dispatch_get_main_queue(), click);
    return sent;
}
#endif
