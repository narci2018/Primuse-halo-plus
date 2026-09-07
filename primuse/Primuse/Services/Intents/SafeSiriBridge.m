//
//  SafeSiriBridge.m
//  Primuse
//

#import "SafeSiriBridge.h"
#import <TargetConditionals.h>

#if TARGET_OS_IOS
#import <Intents/Intents.h>

@implementation SafeSiriBridge

+ (INSiriAuthorizationStatus)safeSiriAuthorizationStatus {
    @try {
        return [INPreferences siriAuthorizationStatus];
    } @catch (NSException *exception) {
        NSLog(@"[SafeSiriBridge] Caught exception checking Siri status (missing entitlement): %@", exception);
        return INSiriAuthorizationStatusRestricted;
    }
}

+ (void)safeRequestSiriAuthorization:(void (^)(INSiriAuthorizationStatus status))completion {
    @try {
        [INPreferences requestSiriAuthorization:completion];
    } @catch (NSException *exception) {
        NSLog(@"[SafeSiriBridge] Caught exception requesting Siri status: %@", exception);
        if (completion) {
            completion(INSiriAuthorizationStatusRestricted);
        }
    }
}

@end
#endif
