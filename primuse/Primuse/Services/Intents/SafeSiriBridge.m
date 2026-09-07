//
//  SafeSiriBridge.m
//  Primuse
//

#import "SafeSiriBridge.h"
#import <TargetConditionals.h>
#import <dlfcn.h>
#import <CoreFoundation/CoreFoundation.h>

typedef struct __SecTask *SecTaskRef;
typedef SecTaskRef (*SecTaskCreateFromSelfFunc)(CFAllocatorRef);
typedef CFTypeRef (*SecTaskCopyValueForEntitlementFunc)(SecTaskRef, CFStringRef, CFErrorRef *);

@implementation SafeSiriBridge

+ (BOOL)hasSiriEntitlement {
#if TARGET_OS_SIMULATOR
    return NO;
#else
    static BOOL sHasEntitlement = NO;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        SecTaskCreateFromSelfFunc createFunc = (SecTaskCreateFromSelfFunc)dlsym(RTLD_DEFAULT, "SecTaskCreateFromSelf");
        SecTaskCopyValueForEntitlementFunc copyFunc = (SecTaskCopyValueForEntitlementFunc)dlsym(RTLD_DEFAULT, "SecTaskCopyValueForEntitlement");
        if (!createFunc || !copyFunc) {
            sHasEntitlement = NO;
            return;
        }
        SecTaskRef task = createFunc(kCFAllocatorDefault);
        if (!task) {
            sHasEntitlement = NO;
            return;
        }
        CFErrorRef error = NULL;
        CFTypeRef value = copyFunc(task, CFSTR("com.apple.developer.siri"), &error);
        CFRelease(task);
        if (error) {
            CFRelease(error);
        }
        if (value) {
            if (CFGetTypeID(value) == CFBooleanGetTypeID()) {
                sHasEntitlement = CFBooleanGetValue((CFBooleanRef)value);
            }
            CFRelease(value);
        } else {
            sHasEntitlement = NO;
        }
    });
    return sHasEntitlement;
#endif
}

+ (BOOL)hasCloudKitContainerEntitlement:(NSString *)containerID {
#if TARGET_OS_SIMULATOR
    return NO;
#else
    if (!containerID || containerID.length == 0) {
        return NO;
    }
    static SecTaskCreateFromSelfFunc createFunc = NULL;
    static SecTaskCopyValueForEntitlementFunc copyFunc = NULL;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        createFunc = (SecTaskCreateFromSelfFunc)dlsym(RTLD_DEFAULT, "SecTaskCreateFromSelf");
        copyFunc = (SecTaskCopyValueForEntitlementFunc)dlsym(RTLD_DEFAULT, "SecTaskCopyValueForEntitlement");
    });
    if (!createFunc || !copyFunc) {
        return NO;
    }
    SecTaskRef task = createFunc(kCFAllocatorDefault);
    if (!task) {
        return NO;
    }
    CFErrorRef error = NULL;
    CFTypeRef value = copyFunc(task, CFSTR("com.apple.developer.icloud-container-identifiers"), &error);
    CFRelease(task);
    if (error) {
        CFRelease(error);
    }
    if (!value) {
        return NO;
    }
    BOOL hasEntitlement = NO;
    if (CFGetTypeID(value) == CFArrayGetTypeID()) {
        NSArray *identifiers = (__bridge NSArray *)value;
        hasEntitlement = [identifiers containsObject:containerID];
    } else if (CFGetTypeID(value) == CFStringGetTypeID()) {
        NSString *identifier = (__bridge NSString *)value;
        hasEntitlement = [identifier isEqualToString:containerID];
    }
    CFRelease(value);
    return hasEntitlement;
#endif
}

#if TARGET_OS_IOS
+ (INSiriAuthorizationStatus)safeSiriAuthorizationStatus {
    if (![self hasSiriEntitlement]) {
        return INSiriAuthorizationStatusRestricted;
    }
    @try {
        return [INPreferences siriAuthorizationStatus];
    } @catch (NSException *exception) {
        NSLog(@"[SafeSiriBridge] Caught exception checking Siri status: %@", exception);
        return INSiriAuthorizationStatusRestricted;
    }
}

+ (void)safeRequestSiriAuthorization:(void (^)(INSiriAuthorizationStatus status))completion {
    if (![self hasSiriEntitlement]) {
        if (completion) {
            completion(INSiriAuthorizationStatusRestricted);
        }
        return;
    }
    @try {
        [INPreferences requestSiriAuthorization:completion];
    } @catch (NSException *exception) {
        NSLog(@"[SafeSiriBridge] Caught exception requesting Siri status: %@", exception);
        if (completion) {
            completion(INSiriAuthorizationStatusRestricted);
        }
    }
}
#endif

@end
